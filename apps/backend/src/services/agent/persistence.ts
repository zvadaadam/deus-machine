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
  MessageCancelledEvent,
  MessageCreatedEvent,
  PartDoneEvent,
  MessageDoneEvent,
  SessionStartedEvent,
  SessionIdleEvent,
  SessionErrorEvent,
  SessionCancelledEvent,
  AgentSessionIdEvent,
  SessionTitleEvent,
} from "@shared/agent-events";

// ============================================================================
// WriteResult type (mirrors agent-server's pattern)
// ============================================================================

export type WriteResult<T = string> = { ok: true; value: T } | { ok: false; error: string };

// ============================================================================
// Message writes
// ============================================================================

/**
 * Create a message row from a message.created event.
 * This pre-creates the row so that part.done INSERTs have a valid FK target.
 */
export function persistMessageCreated(event: MessageCreatedEvent): WriteResult {
  const db = getDatabase();
  const sentAt = new Date().toISOString();

  try {
    // Check if session exists — if not, we can't create the message
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(event.sessionId);
    if (!session) {
      console.warn(
        `[AgentPersistence] message.created: session ${event.sessionId} not found, skipping`
      );
      return { ok: false, error: "session not found" };
    }

    db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, sent_at)
       VALUES (?, ?, ?, ?)`
    ).run(event.messageId, event.sessionId, event.role, sentAt);
    return { ok: true, value: event.messageId };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist message.created:`, msg);
    return { ok: false, error: msg };
  }
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
 * Persist a finalized part to the parts table.
 *
 * Called on part.done — inserts a row into the `parts` table with the
 * full part data. For TOOL parts, extracts toolCallId and toolName into
 * their own columns for efficient querying.
 */
export function persistPartDone(event: PartDoneEvent): WriteResult {
  const db = getDatabase();
  const part = event.part;

  try {
    db.prepare(
      `INSERT OR REPLACE INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name, parent_tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.partId,
      event.messageId,
      event.sessionId,
      0, // seq — ordering is handled by insertion order for now
      part.type,
      JSON.stringify(part),
      part.type === "TOOL" ? part.toolCallId : null,
      part.type === "TOOL" ? part.toolName : null,
      part.parentToolCallId ?? null
    );

    return { ok: true, value: event.partId };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist part.done:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Set the stop_reason on a completed message.
 *
 * Called on message.done — updates the messages row with the stop reason
 * (e.g. "end_turn", "tool_use"). The parts are already persisted
 * individually via part.done events.
 */
export function persistMessageDone(event: MessageDoneEvent): WriteResult {
  const db = getDatabase();

  try {
    db.prepare(`UPDATE messages SET stop_reason = ? WHERE id = ?`).run(
      event.stopReason ?? null,
      event.messageId
    );

    return { ok: true, value: event.messageId };
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error(`[AgentPersistence] Failed to persist message.done:`, msg);
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
