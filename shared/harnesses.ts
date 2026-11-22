// shared/harnesses.ts
// The harnesses Deus runs and what it chooses for each.

import type { AgentHarness as EngineHarness } from "@zvada/agent-server/protocol";
import type { WorkspaceKind } from "./enums";
import type { ProviderId } from "./types/provider-account";

interface Harness {
  label: string;
  vendor: string;
  /** Vendor aliases in order of preference for a new chat. With no match, use the harness's default. */
  preferredModels: readonly string[];
  /** A window suffix such as `[1m]` selects a context size on a listed model. */
  acceptsWindowSuffix: boolean;
  /** How a turn names an installed app's MCP server. */
  appServers: { prefix: string } | { reserved: readonly string[] };
  /** The provider account a cloud turn needs. A harness with none runs only on this computer. */
  cloudProvider: ProviderId | null;
  /** Whether the harness accepts thinking level `off` when a model's list omits it. */
  acceptsUnlistedOff: boolean;
  /** False when a planning turn can end without giving the person a plan to read. */
  supportsPlanMode: boolean;
}

/** The harnesses Deus runs, in the order it offers them. */
export const HARNESSES = {
  "claude-code": {
    label: "Claude Code",
    vendor: "Anthropic",
    // The alias follows the newest Opus the account offers.
    preferredModels: ["opus"],
    acceptsWindowSuffix: true,
    // Apps keep their ids. The harness owns "computer" and cards read "deus" as Deus's own tools.
    appServers: { reserved: ["computer", "deus"] },
    cloudProvider: "claude",
    // Off disables extended thinking on any model. The model rows list only effort levels.
    acceptsUnlistedOff: true,
    supportsPlanMode: true,
  },
  "codex-app-server": {
    label: "Codex",
    vendor: "OpenAI",
    preferredModels: [],
    acceptsWindowSuffix: false,
    // Codex merges a server with its namesake in the person's config. The engine refuses that collision.
    // App ids have no underscore, so a prefixed name is distinct from the person's app id.
    appServers: { prefix: "deus_" },
    cloudProvider: "codex",
    // Codex lists off where a model takes it and runs an unlisted level as another.
    acceptsUnlistedOff: false,
    supportsPlanMode: true,
  },
  gemini: {
    label: "Gemini",
    vendor: "Google",
    preferredModels: [],
    acceptsWindowSuffix: false,
    appServers: { reserved: [] },
    cloudProvider: null,
    acceptsUnlistedOff: false,
    supportsPlanMode: false,
  },
} as const satisfies Partial<Record<EngineHarness, Harness>>;

/** The harness ids Deus offers on this computer, in picker order. */
export const LOCAL_HARNESSES = Object.keys(HARNESSES) as readonly (keyof typeof HARNESSES)[];

/** A harness runs in Deus Cloud when it names a provider account there. */
export const CLOUD_HARNESSES = LOCAL_HARNESSES.filter((id) => HARNESSES[id].cloudProvider !== null);

/** Cloud turns run with full access. A local chat can plan when its harness supports it. */
export function canPlan(
  harness: string | undefined,
  workspaceKind?: WorkspaceKind | null
): boolean {
  return workspaceKind !== "cloud" && !!harness && !!harnessInfo(harness)?.supportsPlanMode;
}

/** Settings and model lists can come from a build that knows other harnesses. */
export function knownHarness(id: string | null | undefined) {
  return typeof id === "string" && Object.hasOwn(HARNESSES, id)
    ? (id as keyof typeof HARNESSES)
    : undefined;
}

export function harnessInfo(id: string): Harness | undefined {
  const harness = knownHarness(id);
  return harness ? HARNESSES[harness] : undefined;
}
