// backend/src/services/agent/persistence.ts
// Database write functions for persisting canonical agent events.
//
// Adapted from agent-server/db/session-writer.ts. Key differences:
// - Uses backend's getDatabase() (not agent-server's)
// - No notifyBackend() calls (backend handles WS push via invalidate())
// - No FrontendClient calls (backend pushes via query-engine directly)
// - Takes event objects instead of positional args
//
// All functions are synchronous (better-sqlite3 is synchronous).
// Callers (event-handler.ts) call invalidate() after persistence succeeds.

import { getDatabase } from "../../lib/database";
import { uuidv7 } from "@shared/lib/uuid";
import { getErrorMessage } from "@shared/lib/errors";
import type {
  MessageAssistantEvent,
  MessageToolResultEvent,
  MessageResultEvent,
  MessageCancelledEvent,
  MessagePartsFinishedEvent,
  SessionStartedEvent,
  SessionIdleEvent,
  SessionErrorEvent,
  SessionCancelledEvent,
  AgentSessionIdEvent,
  SessionTitleEvent,
} from "@shared/agent-events";
import type { Part, MessagePartsEnvelope } from "@shared/messages";

// ============================================================================
// WriteResult type (mirrors agent-server's pattern)
// ============================================================================

export type WriteResult<T = string> = { ok: true; value: T } | { ok: false; error: string };

// ============================================================================
// Message writes
// ============================================================================

/**
 * Save an assistant message to the messages table.
 * Mirrors agent-server saveAssistantMessage() logic:
 * - Generates a local UUID7 message ID
 * - Stores flat content array, except for cancelled messages which get an envelope
 * - Records the agent_message_id and parent_tool_use_id for linking
 */
export function persistAssistantMessage(event: MessageAssistantEvent): WriteResult {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Store flat content array for normal messages. For "cancelled" messages,
  // write envelope so the frontend can detect cancellation from DB content.
  const contentPayload =
    event.message.stop_reason === "cancelled"
      ? { message: { stop_reason: "cancelled" }, blocks: event.message.content ?? [] }
      : (event.message.content ?? []);
  const content = JSON.stringify(contentPayload);

  try {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, sent_at, model, agent_message_id, parent_tool_use_id)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`
    ).run(
      messageId,
      event.sessionId,
      content,
      sentAt,
      event.model || null,
      event.message.id || null,
      event.message.parent_tool_use_id || null
    );
    return { ok: true, value: messageId };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to save assistant message:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Save a tool_result message (role='user') to the messages table.
 * These contain tool execution results that link tool_use blocks to their outputs.
 */
export function persistToolResultMessage(event: MessageToolResultEvent): WriteResult {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();
  const content = JSON.stringify(event.message.content ?? []);

  try {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, sent_at, agent_message_id, parent_tool_use_id)
       VALUES (?, ?, 'user', ?, ?, ?, ?)`
    ).run(
      messageId,
      event.sessionId,
      content,
      sentAt,
      event.message.id || null,
      event.message.parent_tool_use_id || null
    );
    return { ok: true, value: messageId };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to save tool_result message:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Handle message.result events. No DB write needed — this is informational
 * (success/error_during_execution subtypes). Session status transitions are
 * handled by separate session.idle / session.error events.
 */
export function persistMessageResult(_event: MessageResultEvent): void {
  // No-op: message.result is informational only.
  // Session status is managed by session.idle / session.error events.
}

/**
 * Persist a cancellation: insert a cancelled assistant message marker
 * and set session status to idle.
 *
 * The cancelled message uses the envelope format so the frontend can detect
 * cancellation on reload (the "Turn interrupted" label in AssistantTurn).
 */
export function persistMessageCancelled(event: MessageCancelledEvent): WriteResult {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Empty cancelled message with envelope so frontend detects cancellation
  const content = JSON.stringify({
    message: { stop_reason: "cancelled" },
    blocks: [],
  });

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, sent_at, cancelled_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      ).run(messageId, event.sessionId, content, sentAt, sentAt);

      db.prepare(
        `UPDATE sessions SET status = 'idle', error_message = NULL, error_category = NULL, updated_at = datetime('now') WHERE id = ?`
      ).run(event.sessionId);
    })();

    return { ok: true, value: messageId };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist message.cancelled:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Attach accumulated Parts to the most recent assistant message in a session.
 *
 * Called on message.parts_finished — by this point all legacy message.assistant
 * events for the turn have already been persisted, so the most recent assistant
 * row by seq is the correct target. Stores the full Parts array + usage as JSON
 * in the `parts` column alongside the legacy `content` column.
 */
export function persistMessagePartsFinished(
  event: MessagePartsFinishedEvent,
  parts: Part[]
): WriteResult {
  const db = getDatabase();
  const envelope: MessagePartsEnvelope = {
    parts,
    usage: event.usage,
    finishReason: event.finishReason ?? null,
    cost: event.cost ?? null,
  };
  const partsJson = JSON.stringify(envelope);

  try {
    const result = db
      .prepare(
        `UPDATE messages SET parts = ?
       WHERE id = (
         SELECT id FROM messages
         WHERE session_id = ? AND role = 'assistant'
         ORDER BY seq DESC LIMIT 1
       )`
      )
      .run(partsJson, event.sessionId);

    if ((result as { changes: number }).changes === 0) {
      console.warn(
        `[AgentPersistence] No assistant message found to attach parts: session=${event.sessionId}`
      );
    }

    return { ok: true, value: "updated" };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist message parts:`, msg);
    return { ok: false, error: msg };
  }
}

// ============================================================================
// Session status writes
// ============================================================================

/**
 * Update session status to "working" when a turn starts.
 * Only updates if the session is not already working (idempotent).
 */
export function persistSessionStarted(event: SessionStartedEvent): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'working', error_message = NULL, error_category = NULL, updated_at = datetime('now')
       WHERE id = ? AND status != 'working'`
    ).run(event.sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist session.started:`, msg);
    return { ok: false, error: msg };
  }
}

/** Update session status to "needs_plan_response" when agent requests plan approval. */
export function persistSessionNeedsPlanResponse(sessionId: string): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'needs_plan_response', updated_at = datetime('now') WHERE id = ?`
    ).run(sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist needs_plan_response:`, msg);
    return { ok: false, error: msg };
  }
}

/** Update session status to "needs_response" when agent asks user a question. */
export function persistSessionNeedsResponse(sessionId: string): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'needs_response', updated_at = datetime('now') WHERE id = ?`
    ).run(sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist needs_response:`, msg);
    return { ok: false, error: msg };
  }
}

/** Restore session status to "working" when a pending request is resolved. */
export function persistSessionBackToWorking(sessionId: string): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'working', updated_at = datetime('now')
       WHERE id = ? AND status IN ('needs_plan_response', 'needs_response')`
    ).run(sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to restore working status:`, msg);
    return { ok: false, error: msg };
  }
}

/** Update session status to "idle" when a turn completes. */
export function persistSessionIdle(event: SessionIdleEvent): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'idle', error_message = NULL, error_category = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(event.sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist session.idle:`, msg);
    return { ok: false, error: msg };
  }
}

/** Update session status to "error" with error details. */
export function persistSessionError(event: SessionErrorEvent): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'error', error_message = ?, error_category = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(event.error, event.category, event.sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist session.error:`, msg);
    return { ok: false, error: msg };
  }
}

/** Update session status after cancellation (back to idle). */
export function persistSessionCancelled(event: SessionCancelledEvent): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET status = 'idle', error_message = NULL, error_category = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(event.sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist session.cancelled:`, msg);
    return { ok: false, error: msg };
  }
}

// ============================================================================
// Metadata writes
// ============================================================================

/** Store the agent-provider session ID for resume support. */
export function persistAgentSessionId(event: AgentSessionIdEvent): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `UPDATE sessions SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(event.agentSessionId, event.sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist agent.session_id:`, msg);
    return { ok: false, error: msg };
  }
}

/** Update session title and auto-set workspace title if not already set. */
export function persistSessionTitle(event: SessionTitleEvent): WriteResult<void> {
  const db = getDatabase();

  try {
    db.transaction(() => {
      // Always update session title
      db.prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(
        event.title,
        event.sessionId
      );

      // Auto-set workspace title only if not already set (preserves PR titles and user renames)
      db.prepare(
        `UPDATE workspaces SET title = ?
         WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?)
         AND title IS NULL`
      ).run(event.title, event.sessionId);
    })();
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist session.title:`, msg);
    return { ok: false, error: msg };
  }
}
