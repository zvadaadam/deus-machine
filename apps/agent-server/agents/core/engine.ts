// agent-server/agents/core/engine.ts
// The one construction site for the embedded @zvada/agent-server/core engine: lazy
// registry + runtime singletons shared by all three CoreAgentHandler
// instances, deus's claude embed-tier options (in-process deus MCP suite,
// tool policy, checkpoint hooks, legacy SDK-option parity), and the
// AAP-registered MCP server set with its live hot-swap.

import {
  AgentRuntime,
  createAgentRegistry,
  type AgentRegistry,
  type ClaudeCodeAgent,
} from "@zvada/agent-server/core";
import type { SdkMcpServers } from "@zvada/agent-server/core";
import type { McpServerConfig } from "@zvada/agent-server/protocol";
import { createDeusMCPServer } from "../deus-tools";
import { createCheckpoint } from "./checkpoint";
import { sessions, sessionState } from "./session-state";
import { decideToolUse } from "./tool-policy";

let registry: AgentRegistry | undefined;
let runtime: AgentRuntime | undefined;

/** AAP-registered MCP servers, applied to every claude turn + live-swapped. */
let aapServers: Record<string, McpServerConfig> = {};

/** The AAP server set for the next claude turn's wire config (empty = none). */
export function currentAapServers(): Record<string, McpServerConfig> | undefined {
  return Object.keys(aapServers).length ? aapServers : undefined;
}

function checkpointHook(kind: "start" | "end", sessionId: string, turnId: string | undefined) {
  const state = sessionState(sessionId);
  const id = turnId ?? state.turnId;
  if (id && state.cwd) createCheckpoint(sessionId, id, kind, state.cwd, "[core]");
}

export function getRegistry(): AgentRegistry {
  registry ??= createAgentRegistry({
    harnesses: ["claude-code", "codex-sdk", "codex-app-server"],
    // Deterministic CLIs: always the engine's tested pins (sha-verified,
    // cached downloads), never whatever binary the host happens to have.
    // Operator escape hatches ($CLAUDE_CLI_PATH / $CODEX_CLI_PATH) still win.
    provision: { mode: "pinned" },
    claudeCode: {
      sdkMcpServers: ({ sessionId }) =>
        ({ deus: createDeusMCPServer(sessionId) }) as unknown as SdkMcpServers,
      // Legacy-handler parity: deus can't render AskUserQuestion, and
      // sub-agent text must reach the wire.
      sdkOptions: () => ({
        disallowedTools: ["AskUserQuestion"],
        forwardSubagentText: true,
      }),
      toolPolicy: decideToolUse,
      hooks: ({ sessionId, currentTurnId }) => ({
        UserPromptSubmit: [
          {
            hooks: [
              async () => {
                checkpointHook("start", sessionId, currentTurnId());
                return {};
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              async () => {
                checkpointHook("end", sessionId, currentTurnId());
                return {};
              },
            ],
          },
        ],
      }),
    },
  });
  return registry;
}

export function getRuntime(): AgentRuntime {
  runtime ??= new AgentRuntime(getRegistry());
  return runtime;
}

/**
 * AAP app registration: remember the server set for every future claude turn
 * AND live-swap it onto the given running claude sessions (mid-conversation
 * apps). Defaults to every live claude session — other harnesses have no MCP
 * hot-swap.
 */
export async function setAapMcpServers(
  servers: Record<string, McpServerConfig>,
  liveSessionIds: string[] = [...sessions.entries()]
    .filter(([, s]) => s.harness === "claude")
    .map(([id]) => id)
): Promise<void> {
  aapServers = servers;
  const claude = getRegistry().getAgent("claude-code") as ClaudeCodeAgent;
  const failures: string[] = [];
  for (const sessionId of liveSessionIds) {
    try {
      await claude.setMcpServers(sessionId, servers);
    } catch (error) {
      console.error(`[core] mcp hot-swap failed for ${sessionId}:`, error);
      failures.push(sessionId);
    }
  }
  // Every session was attempted; a failed swap must surface to the caller
  // (the registrar contract: never report a failed set as attached).
  if (failures.length) {
    throw new Error(`mcp hot-swap failed for session(s): ${failures.join(", ")}`);
  }
}
