import { randomUUID } from "node:crypto";
import { checkCatalog, verifyGatewayKey } from "./catalog";
import {
  GATEWAY_PRESETS,
  GATEWAY_FORMATS,
  type GatewayCatalog,
  type GatewayPreset,
  type GatewayStatus,
  type GatewayProblem,
} from "@shared/gateways";
import type * as api from "@shared/api/gateways";
import type { ParsedInputOf } from "@shared/api/op";
import { GatewayError, ValidationError } from "../../lib/errors";
import { initVault, open, seal, vaultProblem } from "../integrations/vault";
import { getSetting, saveSetting } from "../settings.service";
import { invalidate } from "../query-engine";

// Only the public catalog is read by windows. The key is sealed with its destination.
interface Saved {
  ref: string;
  preset: GatewayPreset;
  revision: string;
  credential: string;
}
interface GatewayConnection extends GatewayCatalog {
  apiKey: string;
}

const problems = new Map<string, GatewayProblem>();
const refreshes = new Map<string, Promise<void>>();
function saved(): Saved[] {
  return getSetting("gateways") ?? [];
}

function commit(rows: Saved[]) {
  saveSetting("gateways", rows);
  invalidate(["gateways"]);
}

type Snapshot = Omit<GatewayConnection, "revision" | "ref" | "preset">;

export function gatewayStatuses(): GatewayStatus[] {
  return saved().map(({ revision, ref, preset, credential }) => {
    const snapshot = open<Snapshot>(credential);
    return {
      ref,
      preset,
      revision,
      baseUrl: snapshot?.baseUrl ?? "",
      models: snapshot?.models ?? [],
      formats: snapshot?.formats ?? GATEWAY_PRESETS[preset].formats,
      problem: snapshot
        ? problems.get(revision)
        : new GatewayError(vaultProblem() ?? "Reconnect this gateway to unlock its saved key.")
            .details,
    };
  });
}

export function requireRevision(revision: string) {
  const row = saved().find((g) => g.revision === revision);
  if (!row)
    throw new GatewayError(
      "The gateway connection changed. Open a new chat to choose its current connection.",
      "connection_changed"
    );
  return row;
}

export async function connectionFor(revision: string): Promise<GatewayConnection> {
  await initVault();
  const { ref, preset, credential } = requireRevision(revision);
  const snapshot = open<Snapshot>(credential);
  if (!snapshot)
    throw new GatewayError(vaultProblem() ?? "Reconnect this gateway in AI Providers.");
  gatewayBaseUrl(snapshot.baseUrl, preset, "stored");
  return { ...snapshot, ref, preset, revision };
}

function reportGatewayProblem(revision: string, error: GatewayError) {
  if (!saved().some((row) => row.revision === revision)) return;
  problems.set(revision, error.details);
  invalidate(["gateways"]);
}

const INVALID_BASE_URL = "Enter a gateway base URL without a query or fragment.";

function gatewayBaseUrl(raw: string, preset: GatewayPreset, source: "input" | "stored") {
  const mode = GATEWAY_PRESETS[preset].transport;
  const authority = /^(https?):\/\/([^/?#]+)(?:\/[^?#]*)?$/i.exec(raw);
  if (!authority || /[\s\\]|%(?![a-f\d]{2})/i.test(raw) || !URL.canParse(raw))
    throw new ValidationError(INVALID_BASE_URL);
  const url = new URL(raw);
  const local = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(authority[2]!);
  if (url.username || url.password || authority[2]!.includes("@"))
    throw new ValidationError("Enter the API key in its own field.");
  if (mode === "loopback" && (!local || url.pathname !== "/"))
    throw new ValidationError("Use a loopback address on 127.0.0.1, localhost or [::1].");
  if (url.protocol === "http:" && (!local || mode === "https"))
    throw new ValidationError("Use HTTPS for this base URL.");
  const baseUrl =
    source === "stored" ? raw : url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (preset === "openrouter" && baseUrl !== GATEWAY_PRESETS.openrouter.baseUrl)
    throw new ValidationError("Use the official OpenRouter base URL.");
  return baseUrl;
}

export async function connectGateway(input: ParsedInputOf<typeof api.connectGateway>) {
  const { preset } = input;
  const spec = GATEWAY_PRESETS[preset];
  const baseUrl = gatewayBaseUrl(input.baseUrl, preset, "input");
  const existing = input.revision ? requireRevision(input.revision) : undefined;
  if (existing && existing.preset !== preset)
    throw new ValidationError("Choose the saved gateway to edit.");
  const previous = existing && !input.apiKey ? await connectionFor(existing.revision) : undefined;
  const chosen =
    input.formats ??
    previous?.formats ??
    (existing && open<Snapshot>(existing.credential)?.formats) ??
    [];
  const formats = spec.formats.length
    ? spec.formats
    : GATEWAY_FORMATS.filter((f) => chosen.includes(f));
  if (!formats.length) throw new ValidationError("Choose at least one API format.");
  if (!input.apiKey && previous?.baseUrl !== baseUrl)
    throw new ValidationError("Enter the API key for this base URL.");
  const apiKey = input.apiKey ?? previous?.apiKey;
  let decoded: string;
  try {
    decoded = decodeURIComponent(baseUrl);
  } catch {
    throw new ValidationError(INVALID_BASE_URL);
  }
  if (!apiKey || baseUrl.includes(apiKey) || decoded.includes(apiKey))
    throw new ValidationError("Enter the API key in its own field.");
  const same = previous && formats.join() === previous.formats.join();
  const connection = { baseUrl, apiKey, preset, formats };
  const signal = AbortSignal.timeout(5000);
  try {
    await verifyGatewayKey(connection, signal);
  } catch (error) {
    if (same && error instanceof GatewayError) reportGatewayProblem(previous.revision, error);
    throw error;
  }
  if (same) return refreshGateway(previous.revision, signal);
  const revision = randomUUID();
  const models = await checkCatalog(connection, signal);
  await initVault("seal");
  const current = input.revision ? requireRevision(input.revision) : undefined;
  const rows = saved();
  if (
    rows.some(
      (row) =>
        row.ref !== current?.ref &&
        row.preset === preset &&
        open<Snapshot>(row.credential)?.baseUrl === baseUrl
    )
  )
    throw new ValidationError("This gateway is already connected. Edit its saved connection.");
  const ref = current?.ref ?? randomUUID();
  const row: Saved = {
    ref,
    preset,
    revision,
    credential: seal({ baseUrl, apiKey, models, formats }),
  };
  if (current) problems.delete(current.revision);
  commit(current ? rows.map((g) => (g.ref === ref ? row : g)) : [...rows, row]);
}

export function disconnectGateway(revision: string) {
  const row = requireRevision(revision);
  problems.delete(revision);
  commit(saved().filter((g) => g.ref !== row.ref));
}

export function refreshGateway(revision: string, signal?: AbortSignal) {
  const pending = refreshes.get(revision);
  if (pending) return pending;
  const refresh = refreshCatalog(revision, signal).finally(() => refreshes.delete(revision));
  refreshes.set(revision, refresh);
  return refresh;
}

async function refreshCatalog(revision: string, signal?: AbortSignal) {
  const { baseUrl, apiKey, preset, formats } = await connectionFor(revision);
  let models;
  try {
    models = await checkCatalog({ baseUrl, apiKey, preset, formats }, signal);
  } catch (error) {
    if (error instanceof GatewayError) reportGatewayProblem(revision, error);
    throw error;
  }
  requireRevision(revision);
  problems.delete(revision);
  commit(
    saved().map((row) =>
      row.revision === revision
        ? { ...row, credential: seal({ baseUrl, apiKey, formats, models }) }
        : row
    )
  );
}
