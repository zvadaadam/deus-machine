import { z } from "zod";
import { DEFAULT_PINS } from "@zvada/agent-server/core";
import {
  CATALOG_MODELS,
  THINKING_LEVELS,
  credentialFormat,
  type ModelDescriptor,
} from "@zvada/agent-server/protocol";
import {
  GATEWAY_PRESETS,
  type GatewayFormat,
  type GatewayCatalog,
  type GatewayModel,
} from "@shared/gateways";
import { GatewayError } from "../../lib/errors";

// Catalog requests

async function readGatewayJson(response: Response, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type CatalogConnection = Pick<GatewayCatalog, "baseUrl" | "preset" | "formats"> & {
  apiKey: string;
};

async function request(connection: CatalogConnection, path: string, signal: AbortSignal) {
  const { baseUrl, apiKey } = connection;
  const spec = GATEWAY_PRESETS[connection.preset];
  const name = spec.label;
  const headers = { Authorization: "Bearer " + apiKey };
  let response: Response;
  try {
    response = await fetch(baseUrl + path, { headers, redirect: "manual", signal });
  } catch {
    throw new GatewayError(`Nothing answers at this base URL. Is ${name} running?`, "unreachable");
  }
  if (response.ok) return response;
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403)
    throw new GatewayError(name + " rejected the API key.", "api_key");
  throw new GatewayError(
    `${name} could not ${path === spec.keyPath ? "verify the API key" : "list its models"} (HTTP ${response.status}).`,
    "catalog"
  );
}

export async function verifyGatewayKey(connection: CatalogConnection, signal: AbortSignal) {
  const { keyPath, label } = GATEWAY_PRESETS[connection.preset];
  if (!keyPath) return;
  const auth = await request(connection, keyPath, signal);
  try {
    z.object({ data: z.object({ label: z.string() }) }).parse(
      await readGatewayJson(auth, 64 * 1024)
    );
  } catch {
    throw new GatewayError(label + " could not verify the API key.", "api_key");
  }
}

export async function checkCatalog(
  connection: CatalogConnection,
  signal = AbortSignal.timeout(5000)
): Promise<GatewayModel[]> {
  const spec = GATEWAY_PRESETS[connection.preset];
  const response = await request(connection, "/v1/models", signal);
  try {
    const { data } = z
      .object({ data: z.array(publicModel).max(catalogLimit) })
      .parse(await readGatewayJson(response, 8 * 1024 * 1024));
    // The rich list supplies display order and effort when the endpoint offers them.
    const rich = new Map<string, z.infer<typeof clientModel>>();
    if (spec.catalog === "codex-client")
      try {
        const extra = await request(
          connection,
          "/v1/models?client_version=" + encodeURIComponent(DEFAULT_PINS.codex),
          signal
        );
        const { models } = z
          .object({ models: z.array(z.unknown()).max(catalogLimit) })
          .parse(await readGatewayJson(extra, 4 * 1024 * 1024));
        for (const item of models) {
          const parsed = clientModel.safeParse(item);
          if (parsed.success) rich.set(parsed.data.slug, parsed.data);
        }
      } catch {
        /* The client catalog is optional. */
      }
    const rows = new Map<string, GatewayModel>();
    for (const item of data) {
      const row = describeModel(item, connection.formats, spec.catalog, rich.get(item.id));
      if ([row.id, row.provider, row.label].some((value) => value?.includes(connection.apiKey)))
        throw new Error();
      rows.set(row.id, row);
    }
    const published = new Set([...rich.keys(), ...rows.keys()]);
    return [...published].flatMap((id) => rows.get(id) ?? []);
  } catch {
    throw new GatewayError(spec.label + " returned an unreadable model list.", "catalog");
  }
}

// Gateway catalog shapes

const id = z.string().trim().min(1).max(256);
const capabilities = z.object({
  visibility: z.string().nullish(),
  supported_endpoints: z.array(z.string()).nullish(),
  output_modalities: z.array(z.string()).nullish(),
  supported_parameters: z.array(z.string()).nullish(),
});
const publicModel = capabilities.extend({
  id,
  display_name: z.string().trim().max(256).nullish(),
  owned_by: z.string().trim().max(128).nullish(),
  name: z.string().nullish(),
  endpoints: z.array(z.string()).nullish(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  reasoning: z
    .object({
      supported_efforts: z.array(z.string()).nullish(),
      default_effort: z.string().nullish(),
    })
    .nullish(),
});
const clientModel = capabilities.extend({
  slug: id,
  display_name: z.string().trim().max(256).nullish(),
  supported_reasoning_levels: z
    .array(z.object({ effort: z.string() }))
    .max(64)
    .nullish(),
  default_reasoning_level: z.string().nullish(),
});
const catalogLimit = 4096;

// Project a catalog row for discovery and admission.

function fitEfforts(
  formats: readonly GatewayFormat[],
  offered?: readonly string[] | null,
  preferred?: string | null,
  known?: ModelDescriptor
): Pick<GatewayModel, "thinkingByFormat"> {
  if (!offered?.length) return {};
  const byFormat: NonNullable<GatewayModel["thinkingByFormat"]> = {};
  for (const format of formats) {
    const harness = format === "messages" ? "claude-code" : "codex-app-server";
    const supported =
      known?.harness === harness
        ? known.thinking.levels
        : CATALOG_MODELS.filter((model) => model.harness === harness).flatMap(
            (model) => model.thinking.levels
          );
    const normalize = (level: string) =>
      format === "responses" && ["none", "minimal"].includes(level) ? "off" : level;
    const advertised = offered.map(normalize);
    const levels = THINKING_LEVELS.filter(
      (level) => supported.includes(level) && advertised.includes(level)
    );
    if (!levels.length) continue;
    const defaultLevel = preferred && levels.find((level) => level === normalize(preferred));
    byFormat[format] = { levels, ...(defaultLevel && { default: defaultLevel }) };
  }
  return Object.keys(byFormat).length ? { thinkingByFormat: byFormat } : {};
}

// The Codex client catalog synthesizes visible rows for arbitrary aliases. A tool-capable
// endpoint or a trusted exact vendor/model match is what makes a row a chat choice.
function describeModel(
  row: z.infer<typeof publicModel>,
  formats: readonly GatewayFormat[],
  catalog: (typeof GATEWAY_PRESETS)[keyof typeof GATEWAY_PRESETS]["catalog"],
  rich?: z.infer<typeof clientModel>
): GatewayModel {
  // An OpenRouter model id is author/slug. Other catalogs can supply the owner directly.
  const slash = row.id.indexOf("/");
  const provider = row.owned_by ?? (slash > 0 ? row.id.slice(0, slash) : "");
  const family = provider.toLowerCase();
  const vendorId = slash > 0 ? row.id.slice(slash + 1) : row.id;
  const endpoints = row.endpoints ?? row.supported_endpoints ?? rich?.supported_endpoints;
  const outputs =
    row.architecture?.output_modalities ?? row.output_modalities ?? rich?.output_modalities;
  const inputs = row.architecture?.input_modalities;
  const tools = (row.supported_parameters ?? rich?.supported_parameters)?.includes("tools");
  const availableFormats = endpoints
    ? formats.filter((format) =>
        endpoints.some(
          (path) => path === format || path === "/v1/" + format || path === "/api/v1/" + format
        )
      )
    : formats;
  const codex = availableFormats.includes("responses");
  const claude = availableFormats.includes("messages");
  const explicit = tools && outputs?.includes("text");
  const known = CATALOG_MODELS.find(
    (m) =>
      m.id !== "default" &&
      (m.id === vendorId || m.resolvedId === vendorId) &&
      (m.harness === "codex-app-server"
        ? ["openai", "codex"].includes(family) || (explicit && codex)
        : m.harness === "claude-code" &&
          (["anthropic", "claude"].includes(family) || (explicit && claude)))
  );
  const label =
    [row.display_name, rich?.display_name, row.name?.trim().slice(0, 256)].find(
      (name) => name && name !== row.id
    ) ??
    known?.label ??
    row.id;
  const base = { id: row.id, provider, label };
  if (
    row.visibility === "hide" ||
    row.visibility === "hidden" ||
    (rich?.visibility && rich.visibility !== "list")
  )
    return { ...base, excluded: "hidden" };
  if (
    (outputs && !outputs.includes("text")) ||
    (inputs && !inputs.includes("text")) ||
    tools === false
  )
    return { ...base, excluded: "non_chat" };
  if (catalog === "standard") {
    if (!availableFormats.length) return { ...base, excluded: "non_chat" };
    return {
      ...base,
      ...(endpoints && { formats: availableFormats }),
      ...fitEfforts(
        availableFormats,
        row.reasoning?.supported_efforts,
        row.reasoning?.default_effort
      ),
    };
  }
  if (catalog === "described" && !(inputs?.includes("text") && explicit)) return base;
  let runner: GatewayModel["runner"];
  if (known?.harness === "codex-app-server" && codex) runner = known.harness;
  else if (known?.harness === "claude-code" && claude) runner = known.harness;
  else if (explicit && (codex || claude)) {
    runner =
      claude && (!codex || ["claude", "anthropic"].includes(family))
        ? "claude-code"
        : "codex-app-server";
  }
  if (!runner) return base;
  const effortNames =
    (row.supported_parameters?.some((p) => p === "reasoning" || p === "reasoning_effort")
      ? row.reasoning?.supported_efforts
      : undefined) ??
    (known && rich?.supported_reasoning_levels?.map((level) => level.effort));
  const preferred = rich?.default_reasoning_level ?? row.reasoning?.default_effort;
  return {
    ...base,
    runner,
    ...fitEfforts([credentialFormat(runner)], effortNames, preferred, known),
  };
}
