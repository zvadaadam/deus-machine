// agent-server/agents/core/engine.ts
// The one construction site for the embedded @zvada/agent-server/core engine:
// lazy registry + runtime singletons, the Deus tools every harness gets
// (`hostTools`), and deus's Claude embed-tier options (tool policy, checkpoint hooks).

import { AgentRuntime, createAgentRegistry, type AgentRegistry } from "@zvada/agent-server/core";
import { spawn } from "node:child_process";
import { LOCAL_HARNESSES } from "@shared/harnesses";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { deusTools } from "../deus-tools";
import { getShellEnvironment } from "../environment";
import { chatTools, heldCredential } from "../../host-link";
import { trackedSessions } from "../../session-tracker";
import { createCheckpoint } from "./checkpoint";
import { decideToolUse } from "./tool-policy";

let registry: AgentRegistry | undefined;
let runtime: AgentRuntime | undefined;
const SHELL_RUNTIME_KEYS = ["NODE_ENV", "PORT", "NODE_PATH", "BUN_OPTIONS"] as const;

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
    harnesses: [...LOCAL_HARNESSES],
    credentials: heldCredential,
    // The engine uses a staged CLI or its verified pin. It downloads agy on first use.
    provision: { mode: "pinned" },
    // Harnesses merge their environment with process.env before reaching this hook.
    nativeProcesses: {
      spawn: (command, args, options) => {
        const env = createBackendChildEnv({}, options.env);
        const shell = getShellEnvironment();
        for (const key of SHELL_RUNTIME_KEYS) {
          if (shell[key] !== undefined) env[key] = shell[key];
        }
        return spawn(command, args, { ...options, env });
      },
    },
    hostTools: ({ sessionId }) => chatTools(sessionId, deusTools(sessionId)),
    claudeCode: {
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
