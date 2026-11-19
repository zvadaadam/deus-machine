// The names of the MCP servers Deus gives a turn.
//
// Codex merges a thread's server over one of the same name in the person's
// own Codex configuration, and the engine refuses such a turn ("rename one of
// them"). So on Codex every server of Deus's is `deus_<name>`: an app's id
// never has an underscore, and a person's own server is not named that way.
// Claude's keep the app's id. Cards read a tool's server and name from its
// part (`mcp`), never from the harness's spelling.

import type { AgentHarness } from "./enums";

/** Names Claude's harness keeps for its own servers. */
const RESERVED = new Set(["computer"]);

/** The name a turn on `harness` gives an installed app's server. */
export function appServerName(appId: string, harness: AgentHarness): string {
  const name = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (harness === "codex-app-server") return `deus_${name}`;
  return RESERVED.has(name) ? `app_${name}` : name;
}

/**
 * Deus's own tools, on every harness (the engine's `hostTools`). Not `deus`,
 * which a person may have named Deus's remote-access server in their own
 * Codex or Claude config, and no `deus_<id>` an app can have: an app id has no
 * underscore.
 */
export const DEUS_TOOLS_SERVER = "deus_chat_tools";

/**
 * A tool's name as a card knows it, whichever harness called it: an MCP
 * tool's own name, from the part (Claude spells the call `mcp__<server>__<tool>`,
 * Codex `<server>.<tool>`), else the harness's tool name.
 */
export function toolCardName(part: { toolName: string; mcp?: { tool: string } }): string {
  return part.mcp?.tool ?? part.toolName;
}
