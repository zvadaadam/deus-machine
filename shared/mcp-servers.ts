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

/**
 * Deus's own tools on Codex, which reaches them over this computer's
 * loopback (Claude runs them in process, as `deus`). Not `deus`, which a
 * person may have named Deus's remote-access server in their own config, and
 * no `deus_<id>` an app can have: an app id has no underscore.
 */
export const DEUS_TOOLS_SERVER = "deus_chat_tools";

/**
 * A tool's name as a card knows it, whichever harness called it: Claude
 * names an MCP tool `mcp__<server>__<tool>`, Codex names Deus's own
 * `deus_chat_tools.<tool>`.
 */
export function bareToolName(toolName: string): string {
  if (toolName.startsWith(`${DEUS_TOOLS_SERVER}.`)) {
    return toolName.slice(DEUS_TOOLS_SERVER.length + 1);
  }
  const parts = toolName.split("__");
  return toolName.startsWith("mcp__") && parts.length >= 3 ? parts.slice(2).join("__") : toolName;
}
