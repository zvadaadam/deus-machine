import { randomUUID } from "node:crypto";
import { checkCatalog, verifyGatewayKey } from "./agent/gateway";
import {
  GATEWAY_PRESETS,
  GATEWAY_FORMATS,
  type GatewayCatalog,
  type GatewayKind,
  type GatewayStatus,
  type GatewayProblem,
} from "@shared/gateways";
import type * as api from "@shared/api/gateways";
import type { ParsedInputOf } from "@shared/api/op";
import { GatewayError, ValidationError } from "../lib/errors";
import { initVault, open, seal, vaultProblem } from "./integrations/vault";
import { getSetting, saveSetting } from "./settings.service";
import { invalidate } from "./query-engine";

// Only the public catalog is read by windows. The key is sealed with its destination.
interface Saved {
  ref: string;
  preset: GatewayKind;
  generation: string;
  credential: string;
}
interface GatewayConnection extends GatewayCatalog {
  clientKey: string;
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

type Snapshot = Omit<GatewayConnection, "generation" | "ref" | "preset">;

export function gatewayStatuses(): GatewayStatus[] {
  return saved().map(({ generation, ref, preset, credential }) => {
    const snapshot = open<Snapshot>(credential);
    return {
      ref,
      preset,
      generation,
      address: snapshot?.address ?? "",
      models: snapshot?.models ?? [],
      formats: snapshot?.formats ?? GATEWAY_PRESETS[preset].formats,
      problem: snapshot
        ? problems.get(generation)
        : new GatewayError(vaultProblem() ?? "Reconnect this gateway to unlock its saved key.")
            .details,
    };
  });
}

export function requireGeneration(generation: string) {
  const row = saved().find((g) => g.generation === generation);
  if (!row)
    throw new GatewayError(
      "The gateway connection changed. Open a new chat to choose its current connection.",
      "connection_changed"
    );
  return row;
}

export async function connectionFor(generation: string): Promise<GatewayConnection> {
  await initVault();
  const { ref, preset, credential } = requireGeneration(generation);
  const snapshot = open<Snapshot>(credential);
  if (!snapshot)
    throw new GatewayError(vaultProblem() ?? "Reconnect this gateway in AI Providers.");
  gatewayAddress(snapshot.address, preset, "stored");
  return { ...snapshot, ref, preset, generation };
}

function reportGatewayProblem(generation: string, error: GatewayError) {
  if (!saved().some((row) => row.generation === generation)) return;
  problems.set(generation, error.details);
  invalidate(["gateways"]);
}

function gatewayAddress(raw: string, preset: GatewayKind, source: "input" | "stored") {
  const mode = GATEWAY_PRESETS[preset].transport;
  const authority = /^(https?):\/\/([^/?#]+)(?:\/[^?#]*)?$/i.exec(raw);
  if (!authority || /[\s\\]/.test(raw) || !URL.canParse(raw))
    throw new ValidationError("Enter a gateway base URL without a query or fragment.");
  const url = new URL(raw);
  const local = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(authority[2]!);
  if (url.username || url.password || authority[2]!.includes("@"))
    throw new ValidationError("Enter the API key in its own field.");
  if (mode === "loopback" && (!local || url.pathname !== "/"))
    throw new ValidationError("Use a loopback address on 127.0.0.1, localhost or [::1].");
  if (url.protocol === "http:" && (!local || mode === "https"))
    throw new ValidationError("Use HTTPS for this gateway address.");
  const address =
    source === "stored" ? raw : url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (preset === "openrouter" && address !== GATEWAY_PRESETS.openrouter.address)
    throw new ValidationError("Use the official OpenRouter address.");
  return address;
}

export async function connectGateway(input: ParsedInputOf<typeof api.connectGateway>) {
  const { preset } = input;
  const spec = GATEWAY_PRESETS[preset];
  const address = gatewayAddress(input.address, preset, "input");
  const existing = input.generation ? requireGeneration(input.generation) : undefined;
  if (existing && existing.preset !== preset)
    throw new ValidationError("Choose the saved gateway to edit.");
  const previous =
    existing && !input.clientKey ? await connectionFor(existing.generation) : undefined;
  const chosen =
    input.formats ??
    previous?.formats ??
    (existing && open<Snapshot>(existing.credential)?.formats) ??
    [];
  const formats = spec.formats.length
    ? spec.formats
    : GATEWAY_FORMATS.filter((f) => chosen.includes(f));
  if (!formats.length) throw new ValidationError("Choose at least one API format.");
  if (!input.clientKey && previous?.address !== address)
    throw new ValidationError("Enter the client key for this address.");
  const clientKey = input.clientKey ?? previous?.clientKey;
  if (!clientKey || address.includes(clientKey))
    throw new ValidationError("Enter the API key in its own field.");
  const same = previous && formats.join() === previous.formats.join();
  const connection = { address, clientKey, preset, formats };
  const signal = AbortSignal.timeout(5000);
  try {
    await verifyGatewayKey(connection, signal);
  } catch (error) {
    if (same && error instanceof GatewayError) reportGatewayProblem(previous.generation, error);
    throw error;
  }
  if (same) return refreshGateway(previous.generation, signal);
  const generation = randomUUID();
  const models = await checkCatalog(connection, signal);
  await initVault("seal");
  const current = input.generation ? requireGeneration(input.generation) : undefined;
  const rows = saved();
  if (
    rows.some(
      (row) =>
        row.ref !== current?.ref &&
        row.preset === preset &&
        open<Snapshot>(row.credential)?.address === address
    )
  )
    throw new ValidationError("This gateway is already connected. Edit its saved connection.");
  const ref = current?.ref ?? randomUUID();
  const row: Saved = {
    ref,
    preset,
    generation,
    credential: seal({ address, clientKey, models, formats }),
  };
  if (current) problems.delete(current.generation);
  commit(current ? rows.map((g) => (g.ref === ref ? row : g)) : [...rows, row]);
}

export function disconnectGateway(generation: string) {
  const row = requireGeneration(generation);
  problems.delete(generation);
  commit(saved().filter((g) => g.ref !== row.ref));
}

export function refreshGateway(generation: string, signal?: AbortSignal) {
  const pending = refreshes.get(generation);
  if (pending) return pending;
  const refresh = refreshCatalog(generation, signal).finally(() => refreshes.delete(generation));
  refreshes.set(generation, refresh);
  return refresh;
}

async function refreshCatalog(generation: string, signal?: AbortSignal) {
  const { address, clientKey, preset, formats } = await connectionFor(generation);
  let models;
  try {
    models = await checkCatalog({ address, clientKey, preset, formats }, signal);
  } catch (error) {
    if (error instanceof GatewayError) reportGatewayProblem(generation, error);
    throw error;
  }
  requireGeneration(generation);
  problems.delete(generation);
  commit(
    saved().map((row) =>
      row.generation === generation
        ? { ...row, credential: seal({ address, clientKey, formats, models }) }
        : row
    )
  );
}
