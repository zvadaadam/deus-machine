// agent-server/agents/core/engine.ts
// The one construction site for the embedded @zvada/agent-server/core engine:
// lazy registry + runtime singletons, and deus's claude embed-tier options
// (in-process deus MCP suite, tool policy, checkpoint hooks).

import { AgentRuntime, createAgentRegistry, type AgentRegistry } from "@zvada/agent-server/core";
import type { SdkMcpServers } from "@zvada/agent-server/core";
import { createDeusMCPServer } from "../deus-tools";
import { trackedSessions } from "../../session-tracker";
import { createCheckpoint } from "./checkpoint";
import { decideToolUse } from "./tool-policy";

let registry: AgentRegistry | undefined;
let runtime: AgentRuntime | undefined;

async function checkpointHook(
  kind: "start" | "end",
  sessionId: string,
  turnId: string | undefined
): Promise<void> {
  const state = trackedSessions.get(sessionId);
  const id = turnId ?? state?.turnId;
  if (id && state?.cwd) await createCheckpoint(sessionId, id, kind, state.cwd, "[core]");
}

export function getRegistry(): AgentRegistry {
  registry ??= createAgentRegistry({
    harnesses: ["claude-code", "codex-app-server"],
    // Deterministic CLIs: always the engine's tested pins (sha-verified,
    // cached downloads), never whatever binary the host happens to have.
    // Operator escape hatches ($CLAUDE_CLI_PATH / $CODEX_CLI_PATH) still win.
    provision: { mode: "pinned" },
    claudeCode: {
      sdkMcpServers: ({ sessionId }) =>
        ({ deus: createDeusMCPServer(sessionId) }) as unknown as SdkMcpServers,
      // Sub-agent text must reach the wire. Claude's own Cron* tools are off by
      // agent-server (CLAUDE_CODE_DISABLE_CRON): scheduling is Automations'
      // (the deus MCP automation_update tool).
      sdkOptions: () => ({ forwardSubagentText: true }),
      toolPolicy: decideToolUse,
      hooks: ({ sessionId, currentTurnId }) => ({
        UserPromptSubmit: [
          {
            hooks: [
              async () => {
                await checkpointHook("start", sessionId, currentTurnId());
                return {};
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              async () => {
                await checkpointHook("end", sessionId, currentTurnId());
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
