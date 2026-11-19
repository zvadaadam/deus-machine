// The names of the MCP servers Deus gives a turn.
//
// Codex merges a thread's server over one of the same name in the person's
// own Codex configuration, and the engine refuses such a turn ("rename one of
// them"). So on Codex every server of Deus's is `deus_<name>`: an app's id
// never has an underscore, and a person's own server is not named that way.
// Claude's keep the app's id: its tool names (`mcp__<server>__<tool>`) are
// what its transcripts and cards already carry.

import type { AgentHarness } from "./enums";

/** Names Claude's engine and harness keep for their own servers. */
const RESERVED = new Set(["deus", "computer"]);

/** The name a turn on `harness` gives an installed app's server. */
export function appServerName(appId: string, harness: AgentHarness): string {
  const name = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (harness === "codex-app-server") return `deus_${name}`;
  return RESERVED.has(name) ? `app_${name}` : name;
}
