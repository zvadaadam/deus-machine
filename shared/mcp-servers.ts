// The names of the MCP servers Deus gives a turn.
//
// Cards read a tool's server and name from its part (`mcp`).

import type { AgentHarness } from "./enums";
import { HARNESSES } from "./harnesses";

/** The name a turn on `harness` gives an installed app's server. */
export function appServerName(appId: string, harness: AgentHarness): string {
  const name = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const names = HARNESSES[harness].appServers;
  if ("prefix" in names) return names.prefix + name;
  return names.reserved.some((id) => id === name) ? `app_${name}` : name;
}

/**
 * Deus's own tools, on every harness (the engine's `hostTools`). Not `deus`,
 * which a person may have named Deus's remote-access server in their own
 * Codex or Claude config, and no `deus_<id>` an app can have: an app id has no
 * underscore.
 */
export const DEUS_TOOLS_SERVER = "deus_chat_tools";

/**
 * A tool's name as a card knows it, whichever harness called it: a Deus
 * tool's own name, from the part (Claude spells the call
 * `mcp__<server>__<tool>`, Codex `<server>.<tool>`), else the harness's name.
 * Another server's tool keeps its qualified name, so one named like a
 * built-in (a docs server's `Edit`) gets the default card, not the built-in's.
 */
export function toolCardName(part: {
  toolName: string;
  mcp?: { server: string; tool: string };
}): string {
  const prefix = DEUS_TOOL_PREFIXES.find((each) => part.toolName.startsWith(each));
  if (part.mcp && (part.mcp.server === DEUS_TOOLS_SERVER || prefix === OLD_CLAUDE_PREFIX))
    return part.mcp.tool;
  if (part.mcp) return part.toolName;
  return prefix ? part.toolName.slice(prefix.length) : part.toolName;
}

// Names older builds stored for Deus's own tools: Claude's `deus` server (its spelling
// only, never a person's own Codex server named `deus`), and Codex parts without `mcp`.
const OLD_CLAUDE_PREFIX = "mcp__deus__";
const DEUS_TOOL_PREFIXES = [
  OLD_CLAUDE_PREFIX,
  `mcp__${DEUS_TOOLS_SERVER}__`,
  `${DEUS_TOOLS_SERVER}.`,
];
