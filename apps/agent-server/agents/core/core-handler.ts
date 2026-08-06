// agent-server/agents/core/core-handler.ts
// Phase A: deus's AgentHandler implemented over @agent-server/core. Behind
// DEUS_ENGINE=core this replaces ClaudeAgentHandler while keeping deus's wire
// format (via lifecycle-shim) and deus behaviors (deus-tools MCP suite,
// ExitPlanMode round-trip, checkpoint hooks) through the engine's embed-tier
// options. The old handler stays the default until parity is proven.

import {
  callbackSink,
  createAgentRuntime,
  generateUUIDv7,
  type AgentRuntime,
  type ClaudeToolPolicy,
  type SdkMcpServers,
} from "@agent-server/core";
import type { LifecycleEvent, SessionUsageEvent } from "@agent-server/protocol";
import { EventBroadcaster } from "../../event-broadcaster";
import type { AgentHandler, ContextUsageParams, QueryOptions } from "../registry";
import { buildAgentEnvironment } from "../environment/env-builder";
import { createDeusMCPServer } from "../deus-tools";
import { createCheckpoint } from "../claude/checkpoint";
import { LifecycleToPartEvents } from "./lifecycle-shim";

/** Per-deus-session state the core path tracks. */
interface CoreSession {
  turnId?: string;
  cwd?: string;
  lastUsage?: SessionUsageEvent;
}

const sessions = new Map<string, CoreSession>();

/** deus UPPERCASE thinking levels → engine lowercase. */
function toEngineThinking(
  level: QueryOptions["thinkingLevel"]
): "off" | "low" | "medium" | "high" | "xhigh" | undefined {
  switch (level) {
    case "NONE":
      return "off";
    case "LOW":
      return "low";
    case "MEDIUM":
      return "medium";
    case "HIGH":
      return "high";
    case "XHIGH":
      return "xhigh";
    default:
      return undefined;
  }
}

function sessionState(sessionId: string): CoreSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {};
    sessions.set(sessionId, s);
  }
  return s;
}

/** ExitPlanMode approval keeps riding deus's broadcaster round-trip. */
const toolPolicy: ClaudeToolPolicy = async (toolName, input, ctx) => {
  if (toolName !== "ExitPlanMode") return undefined; // engine broker / default flow
  try {
    const response = await EventBroadcaster.requestExitPlanMode({
      sessionId: ctx.sessionId,
      toolInput: input,
    });
    if (response.approved) {
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
      };
    }
    return { behavior: "deny", message: "Plan was not approved", interrupt: false };
  } catch {
    return { behavior: "deny", message: "Plan approval unavailable", interrupt: false };
  }
};

let runtime: AgentRuntime | undefined;

function getRuntime(): AgentRuntime {
  runtime ??= createAgentRuntime({
    harnesses: ["claude-code"],
    claudeCode: {
      sdkMcpServers: ({ sessionId }) =>
        ({ deus: createDeusMCPServer(sessionId) }) as unknown as SdkMcpServers,
      toolPolicy,
      hooks: ({ sessionId, currentTurnId }) => ({
        UserPromptSubmit: [
          {
            hooks: [
              async () => {
                const state = sessionState(sessionId);
                const turnId = currentTurnId() ?? state.turnId;
                if (turnId && state.cwd) {
                  createCheckpoint(sessionId, turnId, "start", state.cwd, "[core]");
                }
                return {};
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              async () => {
                const state = sessionState(sessionId);
                const turnId = currentTurnId() ?? state.turnId;
                if (turnId && state.cwd) {
                  createCheckpoint(sessionId, turnId, "end", state.cwd, "[core]");
                }
                return {};
              },
            ],
          },
        ],
      }),
    },
  });
  return runtime;
}

export class CoreAgentHandler implements AgentHandler {
  readonly agentHarness = "claude" as const;
  readonly capabilities = {
    auth: false,
    workspaceInit: false,
    contextUsage: true,
    modelSwitch: "in-session",
    multiTurn: true,
    sessionResume: true,
    permissionMode: false,
  } satisfies AgentHandler["capabilities"];

  initialize(): { success: boolean; error?: string } {
    return { success: true };
  }

  async query(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    const state = sessionState(sessionId);
    const turnId = options.turnId ?? generateUUIDv7();
    state.turnId = turnId;
    state.cwd = options.cwd;
    const shim = new LifecycleToPartEvents();
    const sink = callbackSink(async (event: LifecycleEvent) => {
      if (event.type === "session.created") {
        EventBroadcaster.emitAgentSessionId(sessionId, event.nativeSessionId);
        return;
      }
      if (event.type === "session.usage") {
        state.lastUsage = event;
        return;
      }
      for (const partEvent of shim.translate(event)) {
        EventBroadcaster.emitPartEvent(
          sessionId,
          this.agentHarness,
          event.turnId ?? turnId,
          partEvent
        );
      }
    });
    await getRuntime().run(
      {
        sessionId,
        turnId,
        input: prompt,
        config: {
          harness: "claude-code",
          cwd: options.cwd,
          model: options.model,
          thinkingLevel: toEngineThinking(options.thinkingLevel),
          permissionMode:
            options.permissionMode === "dontAsk" ? "bypassPermissions" : options.permissionMode,
          maxTurns: options.maxTurns,
          resumeSessionId: options.resume,
          env: buildAgentEnvironment({
            providerEnvVars: options.providerEnvVars,
            deusEnv: options.deusEnv,
            ghToken: options.ghToken,
          }),
        },
      },
      sink
    );
  }

  async cancel(sessionId: string): Promise<void> {
    await getRuntime().cancel("claude-code", sessionId);
  }

  reset(sessionId: string): void {
    sessions.delete(sessionId);
    void getRuntime().closeSession("claude-code", sessionId);
  }

  async getContextUsage(params: ContextUsageParams): Promise<unknown> {
    const state = params.id ? sessions.get(params.id) : undefined;
    const usage = state?.lastUsage;
    return usage
      ? { used: usage.used, size: usage.size, cost: usage.cost }
      : { used: 0, size: undefined, cost: undefined };
  }
}
