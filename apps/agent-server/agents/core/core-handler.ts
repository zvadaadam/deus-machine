// agent-server/agents/core/core-handler.ts
// deus's AgentHandler implemented over the embedded @agent-server/core engine —
// the only engine path (the in-repo claude/codex implementations are gone).
// Keeps deus's wire format (via lifecycle-shim) and deus behaviors (deus-tools
// MCP suite, ExitPlanMode round-trip, checkpoint hooks, AAP MCP hot-swap)
// through the engine's embed-tier options.

import {
  AgentRuntime,
  callbackSink,
  createAgentRegistry,
  generateUUIDv7,
  type AgentRegistry,
  type ClaudeCodeAgent,
  type ClaudeToolPolicy,
  type SdkMcpServers,
} from "@agent-server/core";
import type { McpServerConfig } from "@agent-server/protocol";
import type { LifecycleEvent, SessionUsageEvent } from "@agent-server/protocol";
import { EventBroadcaster } from "../../event-broadcaster";
import type { AgentHandler, ContextUsageParams, QueryOptions } from "../registry";
import { buildAgentEnvironment } from "../environment/env-builder";
import { createDeusMCPServer } from "../deus-tools";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyError } from "../lifecycle";
import { createCheckpoint } from "./checkpoint";
import { LifecycleToPartEvents } from "./lifecycle-shim";
import { buildSystemPromptAppend } from "./system-prompt";

import type { ErrorCategory } from "@shared/enums";

/** Engine error categories → deus error categories (rest fold into internal). */
const ERROR_CATEGORY: Record<string, ErrorCategory> = {
  auth: "auth",
  rate_limit: "rate_limit",
  usage_limit: "rate_limit",
  context_limit: "context_limit",
  network: "network",
  abort: "abort",
  process_exit: "process_exit",
};

/** Per-deus-session state the core path tracks. */
interface CoreSession {
  harness?: DeusHarness;
  turnId?: string;
  cwd?: string;
  lastUsage?: SessionUsageEvent;
  /** Latest QueryOptions — read by the sdkOptions factory at session spawn. */
  lastOptions?: QueryOptions;
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

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Deus tool decisions, ported from the legacy canUseTool (deus has no
 * interactive permission UI, so nothing may fall through to the engine's
 * broker — an unanswered `permission.requested` parks the turn forever):
 *   - ExitPlanMode rides deus's broadcaster round-trip;
 *   - edit tools are denied outside cwd + additionalDirectories;
 *   - everything else is allowed.
 */
export const decideToolUse: ClaudeToolPolicy = async (toolName, input, ctx) => {
  if (toolName === "ExitPlanMode") {
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
  }

  if (EDIT_TOOLS.has(toolName)) {
    const state = sessions.get(ctx.sessionId);
    const cwd = state?.cwd;
    const filePath = String(input.file_path ?? input.notebook_path ?? "");
    if (cwd && filePath) {
      const allowed = [cwd, ...(state?.lastOptions?.additionalDirectories ?? [])].map(
        realpathOrResolve
      );
      const target = realpathOrResolve(filePath);
      if (!allowed.some((dir) => target === dir || target.startsWith(dir + path.sep))) {
        return {
          behavior: "deny",
          message: `Cannot edit files outside allowed directories (${allowed.join(", ")}). Attempted: ${filePath}`,
        };
      }
    }
  }

  return { behavior: "allow", updatedInput: input };
};

const toolPolicy = decideToolUse;

/** deus harness names → engine harness names (all three, no legacy path). */
const ENGINE_HARNESS = {
  claude: "claude-code",
  "codex-sdk": "codex-sdk",
  "codex-server": "codex-app-server",
} as const;
type DeusHarness = keyof typeof ENGINE_HARNESS;

/** AAP-registered MCP servers, applied to every claude turn + live-swapped. */
let aapServers: Record<string, McpServerConfig> = {};

let registry: AgentRegistry | undefined;
let runtime: AgentRuntime | undefined;

function getRegistry(): AgentRegistry {
  registry ??= createAgentRegistry({
    harnesses: ["claude-code", "codex-sdk", "codex-app-server"],
    // Deterministic CLIs: always the engine's tested pins (sha-verified,
    // cached downloads), never whatever binary the host happens to have.
    // Operator escape hatches ($CLAUDE_CLI_PATH / $CODEX_CLI_PATH) still win.
    provision: { mode: "pinned" },
    claudeCode: {
      sdkMcpServers: ({ sessionId }) =>
        ({ deus: createDeusMCPServer(sessionId) }) as unknown as SdkMcpServers,
      // Legacy-handler parity: deus can't render AskUserQuestion, sub-agent
      // text must reach the wire, and Chrome tools ride an extra CLI arg.
      sdkOptions: ({ sessionId }) => {
        const opts = sessions.get(sessionId)?.lastOptions;
        return {
          disallowedTools: ["AskUserQuestion"],
          forwardSubagentText: true,
          ...(opts?.chromeEnabled ? { extraArgs: { chrome: null } } : {}),
        };
      },
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
  return registry;
}

function getRuntime(): AgentRuntime {
  runtime ??= new AgentRuntime(getRegistry());
  return runtime;
}

/**
 * AAP app registration: remember the server set for every future claude turn
 * AND live-swap it onto the given running sessions (mid-conversation apps).
 */
export async function setAapMcpServers(
  servers: Record<string, McpServerConfig>,
  liveSessionIds: string[] = [...sessions.entries()]
    .filter(([, s]) => s.harness === "claude")
    .map(([id]) => id)
): Promise<void> {
  aapServers = servers;
  const claude = getRegistry().getAgent("claude-code") as ClaudeCodeAgent;
  for (const sessionId of liveSessionIds) {
    try {
      await claude.setMcpServers(sessionId, servers);
    } catch (error) {
      console.error(`[core] mcp hot-swap failed for ${sessionId}:`, error);
    }
  }
}

export class CoreAgentHandler implements AgentHandler {
  readonly agentHarness: DeusHarness;
  readonly capabilities = {
    auth: false,
    workspaceInit: false,
    contextUsage: true,
    modelSwitch: "in-session",
    multiTurn: true,
    sessionResume: true,
    // Deliberate cut vs the legacy handler: permission-mode changes apply on
    // the NEXT turn (the engine restarts the session with resume when the mode
    // differs); live mid-turn switching (legacy updatePermissionMode) is gone.
    permissionMode: false,
  } satisfies AgentHandler["capabilities"];

  constructor(harness: DeusHarness = "claude") {
    this.agentHarness = harness;
  }

  private get engineHarness() {
    return ENGINE_HARNESS[this.agentHarness];
  }

  initialize(): { success: boolean; error?: string } {
    return { success: true };
  }

  async query(sessionId: string, prompt: string, options: QueryOptions): Promise<void> {
    const state = sessionState(sessionId);
    const turnId = options.turnId ?? generateUUIDv7();
    state.harness = this.agentHarness;
    state.turnId = turnId;
    state.cwd = options.cwd;
    state.lastOptions = options;
    const shim = new LifecycleToPartEvents();
    let errorReported = false;
    const sink = callbackSink(async (event: LifecycleEvent) => {
      if (event.type === "session.created") {
        EventBroadcaster.emitAgentSessionId(sessionId, event.nativeSessionId);
        return;
      }
      if (event.type === "session.usage") {
        state.lastUsage = event;
        // Live context gauge: the backend persists it onto the session row
        // (context_token_count / context_used_percent) for the composer UI.
        EventBroadcaster.emitSessionContextUsage(sessionId, this.agentHarness, {
          used: event.used,
          size: event.size,
          cost: event.cost,
        });
        return;
      }
      if (event.type === "error") {
        // Turn errors end the turn structurally (turn.ended stopReason=error);
        // this surfaces the message on deus's session.error channel too.
        errorReported = true;
        EventBroadcaster.emitSessionError(
          sessionId,
          this.agentHarness,
          event.error,
          ERROR_CATEGORY[event.code ?? ""] ?? "internal"
        );
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
      if (event.type === "turn.ended") {
        // Terminal session status, matching the legacy handlers: the backend
        // and CLI key agent state off session.idle/cancelled/error — a turn
        // that ends without one of these leaves the product stuck "working".
        // Emitted AFTER the translated turn.completed so the part stream is
        // fully closed before the status flips (legacy ordering).
        if (event.stopReason === "error") {
          if (!errorReported) {
            // Adapter-reported failures (e.g. codex turn.failed) carry the
            // message only on turn.ended.error.
            errorReported = true;
            const classified = classifyError(
              new Error(event.error?.message ?? "agent turn failed")
            );
            EventBroadcaster.emitSessionError(
              sessionId,
              this.agentHarness,
              classified.message,
              classified.category
            );
          }
        } else if (event.stopReason === "cancelled") {
          EventBroadcaster.emitSessionCancelled(sessionId, this.agentHarness);
        } else {
          EventBroadcaster.emitSessionIdle(sessionId, this.agentHarness);
        }
      }
    });
    await getRuntime().run(
      {
        sessionId,
        turnId,
        input: prompt,
        config: {
          harness: this.engineHarness,
          cwd: options.cwd,
          model: options.model,
          thinkingLevel: toEngineThinking(options.thinkingLevel),
          systemPromptAppend: buildSystemPromptAppend(this.agentHarness, options.cwd),
          // Verbatim — the engine speaks dontAsk natively (never-prompt without
          // the dangerous bypass, which also disables Claude extended thinking).
          permissionMode: options.permissionMode,
          maxTurns: options.maxTurns ?? 1000,
          additionalDirectories: options.additionalDirectories,
          resumeSessionId: options.resume,
          mcpServers:
            this.agentHarness === "claude" && Object.keys(aapServers).length
              ? aapServers
              : undefined,
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
    await getRuntime().cancel(this.engineHarness, sessionId);
  }

  reset(sessionId: string): void {
    sessions.delete(sessionId);
    getRuntime()
      .closeSession(this.engineHarness, sessionId)
      .catch((error) => console.warn(`[core] closeSession(${sessionId}) failed:`, error));
  }

  async getContextUsage(params: ContextUsageParams): Promise<unknown> {
    const state = params.id ? sessions.get(params.id) : undefined;
    const usage = state?.lastUsage;
    // null = "not known yet" — a fake zero is indistinguishable from an
    // actually-empty context. (The push path — session.contextUsage — is the
    // primary feed; this pull RPC is kept for external callers.)
    return usage ? { used: usage.used, size: usage.size, cost: usage.cost } : null;
  }
}
