// agent-server/agents/claude/message-processor.ts
// Processes a single deserialized SDK message: emits canonical events, sends to
// frontend, updates stream context. The agent-server is stateless — all DB
// writes are handled by the backend via canonical event consumption.

import { getErrorMessage } from "@shared/lib/errors";
import { EventBroadcaster } from "../../event-broadcaster";
import { classifyStopReason } from "../lifecycle";
import type { StreamContext } from "./stream-context";
import type { SessionState } from "./claude-session";

// ============================================================================
// Types
// ============================================================================

/** Options needed by processMessage that don't change per-message. */
export interface ProcessMessageOptions {
  sessionId: string;
  generatorId: string;
  model: string;
  isResume: boolean;
}

// ============================================================================
// deserializeMessage
// ============================================================================

/**
 * Safely serializes and deserializes an SDK message to strip circular
 * references and produce a clean Record<string, unknown>.
 * Returns null if serialization fails (message should be skipped).
 */
export function deserializeMessage(
  message: unknown,
  generatorId: string
): Record<string, unknown> | null {
  try {
    const seen = new WeakSet();
    const messageStr = JSON.stringify(message, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    return JSON.parse(messageStr);
  } catch (parseError) {
    console.error(
      `[${generatorId}] Failed to serialize/parse SDK message, skipping:`,
      getErrorMessage(parseError)
    );
    return null;
  }
}

// ============================================================================
// processMessage
// ============================================================================

/**
 * Processes a single deserialized SDK message.
 *
 * Side effects (in critical order):
 * 1. Capture agent_session_id (one-shot, first message only, skip on resume)
 * 2. Emit canonical system message event
 * 3. Classify stop_reason and emit canonical error if needed
 * 4. Detect result/success → set ctx.querySucceeded, emit session.idle
 * 5. Detect result/error_during_execution → set ctx.lastResultError
 *
 * The agent-server is stateless — no DB writes. The backend persists messages
 * and updates session status by consuming canonical events via the WS tunnel.
 */
export function processMessage(
  cleanMessage: Record<string, unknown>,
  ctx: StreamContext,
  session: SessionState,
  opts: ProcessMessageOptions
): void {
  // Extract common fields from the deserialized SDK message.
  // cleanMessage is Record<string, unknown> (JSON.parse output), so
  // we narrow once here instead of scattering `as` casts throughout.
  const msg = cleanMessage.message as
    | { id?: string; role?: string; content?: unknown; stop_reason?: string }
    | undefined;

  // 1. One-shot: capture SDK session_id on the first message.
  // CRITICAL: Skip capture during resume attempts. When a resume
  // fails (result/error_during_execution), the SDK returns a NEW
  // session_id that is useless. If we captured it, we'd overwrite
  // the original working agent_session_id — permanently lost.
  if (!session.agentSessionIdCaptured && cleanMessage.session_id && !opts.isResume) {
    const agentSessionId = String(cleanMessage.session_id);

    try {
      // Emit canonical agent.session_id event — backend persists to DB.
      // Set captured flag AFTER emission so a failed send allows retry on next message.
      EventBroadcaster.emitAgentSessionId(opts.sessionId, agentSessionId);
      session.agentSessionIdCaptured = true;
      console.log(`[${opts.generatorId}] Captured agent_session_id: ${agentSessionId}`);
    } catch (error) {
      console.error(
        `[${opts.generatorId}] Failed to emit agent_session_id:`,
        getErrorMessage(error)
      );
    }
  }

  // 2. Emit canonical message events for system messages
  if (cleanMessage.type === "system") {
    EventBroadcaster.emitSystemMessage(opts.sessionId, "claude", cleanMessage);
  }

  // 3. Classify stop_reason and emit canonical error if needed
  if (cleanMessage.type === "assistant" && msg) {
    const stopError = classifyStopReason(msg.stop_reason);
    if (stopError) {
      EventBroadcaster.emitSessionError(
        opts.sessionId,
        "claude",
        stopError.message,
        stopError.category
      );
      ctx.stopReasonError = true;
    }
  }

  // 5. result/success → mark query as succeeded and emit session.idle.
  // Must happen HERE (inside the loop), not in executeOutcome (post-loop),
  // because the streaming loop stays alive between turns — the prompt queue
  // blocks waiting for the next user message, so the post-loop never runs
  // until the entire conversation ends.
  if (cleanMessage.type === "result" && cleanMessage.subtype === "success") {
    ctx.querySucceeded = true;

    if (!ctx.stopReasonError) {
      // Emit canonical session.idle — backend handles DB status update
      EventBroadcaster.emitSessionIdle(opts.sessionId, "claude");
    }
  }

  // 6. result/error_during_execution → capture for error diagnostics
  // NOTE: We intentionally do NOT clear the agent_session_id here.
  // Even if the resume failed, the original ID must be preserved.
  if (cleanMessage.type === "result" && cleanMessage.subtype === "error_during_execution") {
    const errors = cleanMessage.errors as string[] | undefined;
    const resultError =
      Array.isArray(errors) && errors.length > 0
        ? errors.join("; ")
        : typeof cleanMessage.error === "string"
          ? cleanMessage.error
          : "unknown";
    ctx.lastResultError = resultError;
    console.error(`[${opts.generatorId}] result/error_during_execution: ${resultError}`);
  }
}
