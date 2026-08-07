// agent-server/agents/core/core-handler.ts
// deus's AgentHandler implemented over the embedded @agent-server/core engine —
// the only engine path (the in-repo claude/codex implementations are gone).
// This file is just the handler: per-turn config assembly and lifecycle
// forwarding. The engine wiring lives in ./engine, the event translation in
// ./event-bridge (+ ./lifecycle-shim), tool decisions in ./tool-policy, and
// shared per-session state in ./session-state.

import { callbackSink, generateUUIDv7 } from "@agent-server/core";
import type { LifecycleEvent } from "@agent-server/protocol";
import type { AgentHandler, ContextUsageParams, QueryOptions } from "../registry";
import { buildAgentEnvironment } from "../environment/env-builder";
import { CoreEventBridge } from "./event-bridge";
import { currentAapServers, getRuntime } from "./engine";
import { ENGINE_HARNESS, type DeusHarness, sessionState, sessions } from "./session-state";
import { buildSystemPromptAppend } from "./system-prompt";

export { setAapMcpServers } from "./engine";
export { decideToolUse } from "./tool-policy";

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

    const bridge = new CoreEventBridge(sessionId, this.agentHarness, turnId, state);
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
          mcpServers: this.agentHarness === "claude" ? currentAapServers() : undefined,
          env: buildAgentEnvironment({
            providerEnvVars: options.providerEnvVars,
            deusEnv: options.deusEnv,
            ghToken: options.ghToken,
          }),
        },
      },
      callbackSink((event: LifecycleEvent) => bridge.handle(event))
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
