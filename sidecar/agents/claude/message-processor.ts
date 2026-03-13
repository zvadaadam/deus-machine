// sidecar/agents/claude/message-processor.ts
// Processes a single deserialized SDK message: persists to DB, sends to
// frontend, updates stream context. Extracted from the for-await loop body
// in processWithGenerator.

import { getErrorMessage } from "../../../shared/lib/errors";
import { FrontendClient } from "../../frontend-client";
import { classifyStopReason } from "../error-classifier";
import {
  saveAssistantMessage,
  saveToolResultMessage,
  saveAgentSessionId,
  updateSessionStatus,
} from "../../db/session-writer";
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
    const messageStr = JSON.stringify(
      message,
      (_key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        return value;
      }
    );
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
 * 2. Save assistant message to DB
 * 3. Save tool_result message to DB
 * 4. Send to frontend (AFTER DB writes — ordering is critical)
 * 5. Classify stop_reason and send error (AFTER sendMessage — content before error banner)
 * 6. Detect result/success → set ctx.querySucceeded
 * 7. Detect result/error_during_execution → set ctx.lastResultError
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
  const parentToolUseId =
    typeof cleanMessage.parent_tool_use_id === "string"
      ? cleanMessage.parent_tool_use_id
      : null;

  // 1. One-shot: capture SDK session_id on the first message.
  // CRITICAL: Skip capture during resume attempts. When a resume
  // fails (result/error_during_execution), the SDK returns a NEW
  // session_id that is useless. If we captured it, we'd overwrite
  // the original working agent_session_id — permanently lost.
  if (!session.agentSessionIdCaptured && cleanMessage.session_id && !opts.isResume) {
    const agentSessionId = String(cleanMessage.session_id);
    const saveResult = saveAgentSessionId(opts.sessionId, agentSessionId);
    if (saveResult.ok) {
      session.agentSessionIdCaptured = true;
      console.log(`[${opts.generatorId}] Captured agent_session_id: ${agentSessionId}`);
    } else {
      console.error(
        `[${opts.generatorId}] Failed to persist agent_session_id: ${saveResult.error}`
      );
    }
  }

  // 2. Persist assistant messages to database (before frontend notification)
  if (cleanMessage.type === "assistant" && msg) {
    const tDbWrite = Date.now();
    const writeResult = saveAssistantMessage(opts.sessionId, msg, opts.model, parentToolUseId);
    const dbWriteMs = Date.now() - tDbWrite;
    if (!writeResult.ok) {
      console.error(
        `[${opts.generatorId}] DB write failed for assistant message: ${writeResult.error}`
      );
    }
    if (dbWriteMs > 10) {
      console.log(`[TIMING][${opts.generatorId}] saveAssistantMessage took ${dbWriteMs}ms`);
    }
  }

  // 3. Persist user messages with tool_result blocks
  if (cleanMessage.type === "user" && msg) {
    const content = msg.content;
    const hasToolResult =
      Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");
    if (hasToolResult) {
      const tDbWrite = Date.now();
      const writeResult = saveToolResultMessage(opts.sessionId, msg, parentToolUseId);
      const dbWriteMs = Date.now() - tDbWrite;
      if (!writeResult.ok) {
        console.error(
          `[${opts.generatorId}] DB write failed for tool_result message: ${writeResult.error}`
        );
      }
      if (dbWriteMs > 10) {
        console.log(`[TIMING][${opts.generatorId}] saveToolResultMessage took ${dbWriteMs}ms`);
      }
    }
  }

  // 4. Send to frontend via JSON-RPC notification (after DB writes)
  const tSend = Date.now();
  FrontendClient.sendMessage({
    id: opts.sessionId,
    type: "message",
    agentType: "claude",
    data: cleanMessage,
  });
  const sendMs = Date.now() - tSend;
  if (sendMs > 5) {
    console.log(`[TIMING][${opts.generatorId}] sendMessage took ${sendMs}ms`);
  }

  // 5. Classify stop_reason (after sendMessage — content before error banner)
  if (cleanMessage.type === "assistant" && msg) {
    const stopError = classifyStopReason(msg.stop_reason);
    if (stopError) {
      FrontendClient.sendError({
        id: opts.sessionId,
        type: "error",
        error: stopError.message,
        agentType: "claude",
        category: stopError.category,
      });
      updateSessionStatus(opts.sessionId, "error", stopError.message, stopError.category);
      ctx.stopReasonError = true;
    }
  }

  // 6. result/success → mark query as succeeded.
  // Status transition to "idle" is owned by executeOutcome() in stream-context.ts
  // after the streaming loop ends — not here. Doing it here would double-write.
  if (cleanMessage.type === "result" && cleanMessage.subtype === "success") {
    ctx.querySucceeded = true;
  }

  // 7. result/error_during_execution → capture for error diagnostics
  // NOTE: We intentionally do NOT clear the agent_session_id here.
  // Even if the resume failed, the original ID must be preserved.
  if (cleanMessage.type === "result" && cleanMessage.subtype === "error_during_execution") {
    const errors = cleanMessage.errors as string[] | undefined;
    const resultError = Array.isArray(errors) && errors.length > 0
      ? errors.join("; ")
      : typeof cleanMessage.error === "string"
        ? cleanMessage.error
        : "unknown";
    ctx.lastResultError = resultError;
    console.error(`[${opts.generatorId}] result/error_during_execution: ${resultError}`);
  }
}
