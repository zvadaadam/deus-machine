// sidecar/db/session-writer.ts
// Handles message persistence for SDK messages (assistant + tool_result).
// Also updates session status when queries complete.
//
// All write functions return WriteResult so callers can detect and
// surface DB failures instead of silently swallowing them.

import { uuidv7 } from "../../shared/lib/uuid";
import { getDatabase } from "./index";
import { notifyBackend } from "./backend-notifier";

// ── WriteResult ──────────────────────────────────────────────────────────

/**
 * Discriminated union for DB write outcomes.
 * Replaces the old string|null pattern that silently swallowed failures.
 */
export type WriteResult<T = string> = { ok: true; value: T } | { ok: false; error: string };

// ── Save Messages ────────────────────────────────────────────────────────

/**
 * Save an assistant message to the database.
 * Called after FrontendClient.sendMessage() in the Claude handler.
 */
export function saveAssistantMessage(
  sessionId: string,
  message: { id?: string; role?: string; content?: unknown; stop_reason?: string },
  model: string = "opus",
  parentToolUseId: string | null = null
): WriteResult {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Store content blocks directly (flattened — no envelope wrapper).
  // When stop_reason is present (e.g., "cancelled"), wrap in an envelope so
  // the frontend can detect the message state via parsed.message?.stop_reason.
  // Normal messages: [block1, block2, ...]
  // Cancelled messages: { message: { stop_reason }, blocks: [...] }
  const contentPayload = message.stop_reason
    ? { message: { stop_reason: message.stop_reason }, blocks: message.content ?? [] }
    : message.content ?? [];
  const content = JSON.stringify(contentPayload);

  try {
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, model, agent_message_id, parent_tool_use_id)
      VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, model, message.id || null, parentToolUseId);

    console.log(`[SESSION-WRITER] Saved assistant message ${messageId} for session ${sessionId}`);
    notifyBackend("session:message", sessionId);
    return { ok: true, value: messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to save assistant message:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Save a user message containing tool_result blocks to the database.
 * The frontend's toolResultMap needs these to link tool_use → tool_result
 * for displaying execution results (success/failure/output).
 *
 * Without this, tool renderers never receive their result data and show
 * perpetual "in progress" state instead of actual output.
 */
export function saveToolResultMessage(
  sessionId: string,
  message: { id?: string; role?: string; content?: unknown },
  parentToolUseId: string | null = null
): WriteResult {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Store content blocks directly (flattened — no envelope wrapper).
  const content = JSON.stringify(message.content ?? []);

  try {
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, agent_message_id, parent_tool_use_id)
      VALUES (?, ?, 'user', ?, ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, message.id || null, parentToolUseId);

    notifyBackend("session:message", sessionId);
    return { ok: true, value: messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to save tool_result message:`, msg);
    return { ok: false, error: msg };
  }
}

// ── Session Status ───────────────────────────────────────────────────────

/**
 * Update session status (e.g., from 'working' to 'idle').
 * Called when a query completes (result.type === 'result' && result.subtype === 'success').
 *
 * Retries once on SQLITE_BUSY since this is the most critical write —
 * a failed status update leaves the session stuck in "working" forever.
 */
export type SessionStatus = "idle" | "working" | "error";

export function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  errorMessage?: string | null,
  errorCategory?: string | null
): WriteResult<void> {
  const db = getDatabase();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      db.prepare(
        `
        UPDATE sessions SET status = ?, error_message = ?, error_category = ?, updated_at = datetime('now') WHERE id = ?
      `
      ).run(
        status,
        status === "error" ? (errorMessage ?? null) : null,
        status === "error" ? (errorCategory ?? null) : null,
        sessionId
      );

      console.log(
        `[SESSION-WRITER] Updated session ${sessionId} status to '${status}'${errorMessage ? ` with error: ${errorMessage}` : ""}`
      );
      notifyBackend("session:status", sessionId);
      return { ok: true, value: undefined };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && (msg.includes("SQLITE_BUSY") || msg.includes("database is locked"))) {
        console.log(`[SESSION-WRITER] SQLITE_BUSY on status update, retrying in 200ms...`);
        // Synchronous wait — better-sqlite3 is sync anyway
        const start = Date.now();
        while (Date.now() - start < 200) {
          /* spin */
        }
        continue;
      }
      console.error(`[SESSION-WRITER] Failed to update session status:`, msg);
      return { ok: false, error: msg };
    }
  }
  return { ok: false, error: "unreachable" };
}

/**
 * Update session's last_user_message_at timestamp.
 * Called when user sends a message (for optimized workspace list queries).
 */
export function updateLastUserMessageAt(sessionId: string): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `
      UPDATE sessions SET last_user_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `
    ).run(sessionId);
    notifyBackend("session:updated", sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to update last_user_message_at:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Check if a session exists in the database.
 */
export function sessionExists(sessionId: string): boolean {
  const db = getDatabase();
  const result = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
  return !!result;
}

// ── Agent Session ID (Resume Support) ────────────────────────────────

/**
 * Persist the Claude Agent SDK session ID so the sidecar can resume
 * this conversation after a restart (sidecar crash, app relaunch).
 *
 * Called once per generator lifecycle — the first SDK message in the
 * for-await loop carries session_id, which is captured via a one-shot
 * boolean flag on SessionState.
 */
export function saveAgentSessionId(
  sessionId: string,
  agentSessionId: string | null
): WriteResult<void> {
  const db = getDatabase();

  try {
    db.prepare(
      `
      UPDATE sessions SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?
    `
    ).run(agentSessionId, sessionId);

    console.log(
      `[SESSION-WRITER] Saved agent_session_id ${agentSessionId} for session ${sessionId}`
    );
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to save agent_session_id:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Look up the Claude Agent SDK session ID for a given app session.
 * Returns null if no agent_session_id has been captured yet (fresh session).
 *
 * Called by processWithGenerator before building SDK options to decide
 * whether to pass `resume: agentSessionId` to the SDK.
 */
export function lookupAgentSessionId(sessionId: string): string | null {
  const db = getDatabase();

  try {
    const row = db
      .prepare("SELECT agent_session_id FROM sessions WHERE id = ?")
      .get(sessionId) as { agent_session_id: string | null } | undefined;

    return row?.agent_session_id ?? null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to lookup agent_session_id:`, msg);
    return null;
  }
}

// ── Startup Reconciliation ───────────────────────────────────────────

/**
 * Reset sessions stuck in "working" status after a sidecar restart.
 *
 * When the sidecar dies (crash, app close), sessions remain in "working"
 * status in the DB because the finally block in processWithGenerator never
 * ran. This leaves them permanently stuck — the UI shows a spinner forever.
 *
 * Called once during sidecar startup, before accepting any connections.
 */
export function reconcileStuckSessions(): WriteResult<number> {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `
        UPDATE sessions SET status = 'idle', updated_at = datetime('now')
        WHERE status = 'working'
      `
      )
      .run();

    const count = result.changes;
    if (count > 0) {
      console.log(
        `[SESSION-WRITER] Reconciled ${count} stuck session(s) from 'working' to 'idle'`
      );
    }
    return { ok: true, value: count };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to reconcile stuck sessions:`, msg);
    return { ok: false, error: msg };
  }
}
