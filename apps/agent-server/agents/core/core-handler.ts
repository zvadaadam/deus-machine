// agent-server/agents/core/core-handler.ts
// deus's AgentHandler implemented over the embedded @agent-server/core engine —
// the only engine path (the in-repo claude/codex implementations are gone).
// This file is just the handler: per-turn config assembly and lifecycle
// forwarding. The engine wiring lives in ./engine, the event translation in
// ./event-bridge (+ ./lifecycle-shim), tool decisions in ./tool-policy, and
// shared per-session state in ./session-state.

import { callbackSink, generateUUIDv7 } from "@agent-server/core";
import type { AgentInput, LifecycleEvent } from "@agent-server/protocol";
import type { AgentHandler, ContextUsageParams, QueryOptions } from "../registry";
import { buildAgentEnvironment } from "../environment/env-builder";
import { createCheckpoint } from "./checkpoint";
import { CoreEventBridge } from "./event-bridge";
import { currentAapServers, getRuntime } from "./engine";
import { ENGINE_HARNESS, type DeusHarness, sessionState, sessions } from "./session-state";
import { buildSystemPromptAppend } from "./system-prompt";

export { setAapMcpServers } from "./engine";
export { decideToolUse } from "./tool-policy";

/**
 * Deus's frontend serializes attachment-bearing prompts as a JSON array of
 * Anthropic content blocks (text / image with base64 or URL source). The
 * legacy handler passed that array straight to the SDK; the engine speaks its
 * own PartInput vocabulary, so translate. Anything unrecognized stays text.
 */
export function toEngineInput(prompt: string): AgentInput {
  if (!prompt.startsWith("[")) return prompt;
  let blocks: unknown;
  try {
    blocks = JSON.parse(prompt);
  } catch {
    return prompt;
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return prompt;
  const parts: Extract<AgentInput, unknown[]> = [];
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type === "image") {
      const source = block.source as
        | { type?: string; url?: string; media_type?: string; data?: string }
        | undefined;
      if (source?.type === "url" && source.url) {
        parts.push({ type: "image", url: source.url, mediaType: source.media_type ?? "image/png" });
        continue;
      }
      if (source?.data) {
        parts.push({
          type: "image",
          data: source.data,
          mediaType: source.media_type ?? "image/png",
        });
        continue;
      }
    }
    // Unknown block type — not a content array we understand; keep raw text.
    return prompt;
  }
  return parts.length ? parts : prompt;
}

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
  readonly capabilities: AgentHandler["capabilities"];

  constructor(harness: DeusHarness = "claude") {
    this.agentHarness = harness;
    this.capabilities = {
      // Auth status is a claude-only feature (SDK accountInfo); the codex
      // handlers must not advertise it or the settings route would query them.
      auth: harness === "claude",
      workspaceInit: false,
      contextUsage: true,
      modelSwitch: "in-session",
      multiTurn: true,
      sessionResume: true,
      // Deliberate cut vs the legacy handler: permission-mode changes apply on
      // the NEXT turn (the engine restarts the session with resume when the
      // mode differs); live mid-turn switching (updatePermissionMode) is gone.
      permissionMode: false,
    };
  }

  private get engineHarness() {
    return ENGINE_HARNESS[this.agentHarness];
  }

  initialize(): { success: boolean; error?: string } {
    return { success: true };
  }

  /**
   * Provider auth status for the settings screen (legacy parity): spawn an
   * idle SDK query and ask it for the account info, then interrupt it.
   * Claude-only — the codex harnesses report no auth capability.
   */
  async auth(params: { cwd: string }): Promise<unknown> {
    if (this.agentHarness !== "claude") {
      return { type: "claude_auth_output", agentHarness: this.agentHarness, error: "unsupported" };
    }
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const emptyPrompt = (async function* () {})();
      const query = sdk.query({ prompt: emptyPrompt, options: { cwd: params.cwd } });
      try {
        const accountInfo = await query.accountInfo();
        return { type: "claude_auth_output", agentHarness: "claude", accountInfo };
      } finally {
        void query.interrupt().catch(() => {});
      }
    } catch (error) {
      return {
        type: "claude_auth_output",
        agentHarness: "claude",
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
        input: toEngineInput(prompt),
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
          // Checkpoint revert: fork the resumed session at a specific message.
          resumeSessionAt: options.resumeSessionAt,
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
    // A forced cancellation can kill the subprocess before the Stop hook runs —
    // create the end checkpoint first so undo/revert still has its ref
    // (legacy parity; createCheckpoint is a no-op outside a git repo).
    const state = sessions.get(sessionId);
    if (this.agentHarness === "claude" && state?.turnId && state.cwd) {
      createCheckpoint(sessionId, state.turnId, "end", state.cwd, "[core]");
    }
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
