import { credentialFormat, takesHeldCredential } from "@zvada/agent-server/protocol";
import type { ModelDescriptor, ThinkingLevel } from "@zvada/agent-server/protocol";
import type { AgentHarness } from "./enums";

export const GATEWAY_FORMATS = ["messages", "responses"] as const;
export type GatewayFormat = (typeof GATEWAY_FORMATS)[number];
export const GATEWAY_PRESET_IDS = ["openrouter", "cliproxyapi", "custom"] as const;
export type GatewayPreset = (typeof GATEWAY_PRESET_IDS)[number];

interface Preset {
  label: string;
  baseUrl: string;
  transport: "https" | "loopback" | "any";
  formats: readonly GatewayFormat[];
  catalog: "described" | "codex-client" | "standard";
  keyPath?: string;
  rules?: { warning: string; links: readonly (readonly [string, string])[] };
}

export const GATEWAY_PRESETS: Record<GatewayPreset, Preset> = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    transport: "https",
    formats: GATEWAY_FORMATS,
    keyPath: "/v1/key",
    catalog: "described",
  },
  cliproxyapi: {
    label: "CLIProxyAPI",
    baseUrl: "http://127.0.0.1:8317",
    transport: "loopback",
    formats: GATEWAY_FORMATS,
    catalog: "codex-client",
    rules: {
      warning:
        "Safest with API keys. If you sign a personal subscription into the proxy, or switch between accounts to get past a limit, the provider can suspend that account.",
      links: [
        ["Anthropic", "https://code.claude.com/docs/en/legal-and-compliance"],
        ["OpenAI", "https://openai.com/policies/row-terms-of-use/"],
        ["Google", "https://antigravity.google/docs/faq/"],
      ],
    },
  },
  custom: { label: "Custom", baseUrl: "", transport: "any", catalog: "standard", formats: [] },
};

export interface GatewayModel {
  id: string;
  provider: string;
  label: string;
  runner?: "claude-code" | "codex-app-server";
  formats?: readonly GatewayFormat[];
  excluded?: "hidden" | "non_chat";
  thinkingByFormat?: Partial<Record<GatewayFormat, ModelDescriptor["thinking"]>>;
}

export function gatewayEffort(
  thinking: ModelDescriptor["thinking"] | undefined,
  requested?: ThinkingLevel
) {
  if (requested && thinking?.levels.includes(requested)) return requested;
  return thinking?.default ?? thinking?.levels[0];
}

export interface GatewayCatalog {
  revision: string;
  baseUrl: string;
  models: GatewayModel[];
  ref: string;
  preset: GatewayPreset;
  formats: readonly GatewayFormat[];
}

export type GatewayStatus = GatewayCatalog & { problem?: GatewayProblem };

/** A Custom model inherits the gateway's formats where its catalog is silent. */
export function gatewaySupports(
  gateway: Pick<GatewayCatalog, "preset" | "formats">,
  model: GatewayModel,
  harness: AgentHarness
) {
  if (model.excluded || !takesHeldCredential(harness)) return false;
  const format = credentialFormat(harness);
  return (
    gateway.formats.includes(format) &&
    (gateway.preset === "custom"
      ? (model.formats?.includes(format) ?? true)
      : model.runner === harness)
  );
}

export function gatewayThinking(model: GatewayModel | undefined, harness: AgentHarness) {
  return takesHeldCredential(harness)
    ? model?.thinkingByFormat?.[credentialFormat(harness)]
    : undefined;
}

export function gatewayLabel(
  gateway: Pick<GatewayCatalog, "preset" | "baseUrl">,
  gateways: readonly GatewayCatalog[]
) {
  const name = GATEWAY_PRESETS[gateway.preset].label;
  if (
    !gateway.baseUrl ||
    (gateway.preset !== "custom" && gateways.filter((g) => g.preset === gateway.preset).length < 2)
  )
    return name;
  const url = new URL(gateway.baseUrl);
  return name + " · " + url.host + (url.pathname === "/" ? "" : url.pathname);
}

export type GatewayProblem = {
  kind: "unreachable" | "api_key" | "catalog" | "configuration" | "no_route" | "connection_changed";
  message: string;
};
