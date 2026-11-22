import type { AgentHarness as EngineHarness } from "@zvada/agent-server/protocol";
import type { ProviderId } from "./types/provider-account";

interface Harness {
  label: string;
  vendor: string;
  /** Vendor aliases in order of preference for a new chat. With no match, use the harness's default. */
  preferredModels: readonly string[];
  appServers: { prefix: string } | { reserved: readonly string[] };
  /** The provider account a cloud turn needs. A harness with none runs only on this computer. */
  cloudProvider: ProviderId | null;
  acceptsUnlistedOff: boolean;
}

/** The harnesses Deus runs, in the order it offers them. */
export const HARNESSES = {
  "claude-code": {
    label: "Claude Code",
    vendor: "Anthropic",
    // The alias follows the newest Opus the account offers.
    preferredModels: ["opus"],
    // Apps keep their ids. The harness owns "computer" and cards read "deus" as Deus's own tools.
    appServers: { reserved: ["computer", "deus"] },
    cloudProvider: "claude",
    // Off disables extended thinking on any model. The model rows list only effort levels.
    acceptsUnlistedOff: true,
  },
  "codex-app-server": {
    label: "Codex",
    vendor: "OpenAI",
    preferredModels: [],
    // Codex merges a server with its namesake in the person's config. The engine refuses that collision.
    // App ids have no underscore, so a prefixed name is distinct from the person's app id.
    appServers: { prefix: "deus_" },
    cloudProvider: "codex",
    // Codex lists off where a model takes it and runs an unlisted level as another.
    acceptsUnlistedOff: false,
  },
} as const satisfies Partial<Record<EngineHarness, Harness>>;

/** Settings and model lists can come from a build that knows other harnesses. */
export function harnessInfo(id: string): Harness | undefined {
  return Object.hasOwn(HARNESSES, id) ? HARNESSES[id as keyof typeof HARNESSES] : undefined;
}
