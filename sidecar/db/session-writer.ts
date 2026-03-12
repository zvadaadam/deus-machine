// sidecar/db/session-writer.ts
// Handles message persistence for SDK messages (assistant + tool_result).
// Also updates session status when queries complete.
//
// All write functions return WriteResult so callers can detect and
// surface DB failures instead of silently swallowing them.

import { uuidv7 } from "../../shared/lib/uuid";
import { NOTIFY_SESSION_MESSAGE, NOTIFY_SESSION_STATUS, NOTIFY_SESSION_UPDATED } from "../../shared/events";
import { getDatabase } from "./index";
import { notifyBackend } from "./backend-notifier";
import { FrontendClient } from "../frontend-client";
import type { AgentType, ErrorCategory, SessionStatus } from "../../shared/enums";

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
  const t0 = Date.now();
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  // Store flat content array for normal messages. For "cancelled" messages,
  // write envelope so the frontend can detect cancellation from DB content
  // (the "Turn interrupted" label in AssistantTurn needs this to survive page reload).
  // Other stop_reasons (e.g. max_tokens) are communicated via session error events.
  // Old DB rows may have envelope for any stop_reason — the frontend read shim
  // in normalizeContentBlocks handles backward compat.
  const contentPayload =
    message.stop_reason === "cancelled"
      ? { message: { stop_reason: "cancelled" }, blocks: message.content ?? [] }
      : (message.content ?? []);
  const content = JSON.stringify(contentPayload);

  try {
    const tInsert = Date.now();
    db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, sent_at, model, agent_message_id, parent_tool_use_id)
      VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
    `
    ).run(messageId, sessionId, content, sentAt, model, message.id || null, parentToolUseId);
    const insertMs = Date.now() - tInsert;

    const tNotify = Date.now();
    notifyBackend(NOTIFY_SESSION_MESSAGE, sessionId);
    const notifyMs = Date.now() - tNotify;

    const totalMs = Date.now() - t0;
    if (totalMs > 10) {
      console.log(
        `[TIMING][SESSION-WRITER] saveAssistantMessage session=${sessionId} insert=${insertMs}ms notify=${notifyMs}ms total=${totalMs}ms`
      );
    }
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

    notifyBackend(NOTIFY_SESSION_MESSAGE, sessionId);
    return { ok: true, value: messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to save tool_result message:`, msg);
    return { ok: false, error: msg };
  }
}

// ── Save User Message (Atomic Send Path) ────────────────────────────────

/**
 * Save a user message and set session status to "working" in a single
 * SQLite transaction. This is the sidecar-owns-send path: the frontend
 * sends one socket call, and the sidecar atomically persists the message
 * + activates the session before dispatching the agent.
 *
 * If the transaction fails, nothing is persisted — the frontend gets
 * { accepted: false } and can show a clean error without cleanup.
 */
export function saveUserMessage(
  sessionId: string,
  content: string,
  model: string = "opus"
): WriteResult {
  const db = getDatabase();
  const messageId = uuidv7();
  const sentAt = new Date().toISOString();

  try {
    const saveAndActivate = db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, sent_at, model)
         VALUES (?, ?, 'user', ?, ?, ?)`
      ).run(messageId, sessionId, content, sentAt, model);

      db.prepare(
        `UPDATE sessions SET status = 'working', last_user_message_at = ?,
         error_message = NULL, error_category = NULL,
         updated_at = datetime('now') WHERE id = ?`
      ).run(sentAt, sessionId);
    });

    saveAndActivate();
    notifyBackend(NOTIFY_SESSION_MESSAGE, sessionId);

    // Emit statusChanged so the frontend receives a real Tauri event for
    // the working transition — not just the optimistic onMutate update.
    // If the socket ACK is lost and onError rolls back, this event re-corrects.
    try {
      const workspaceId = lookupWorkspaceId(sessionId);
      const agentType = lookupAgentType(sessionId);
      FrontendClient.sendStatusChanged({
        type: "status_changed",
        id: sessionId,
        agentType,
        status: "working",
        ...(workspaceId ? { workspaceId } : {}),
      });
    } catch {
      // No tunnel attached — frontend relies on optimistic update
    }

    return { ok: true, value: messageId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to save user message:`, msg);
    return { ok: false, error: msg };
  }
}

// ── Workspace Lookup ─────────────────────────────────────────────────────

/**
 * Look up the workspace_id for a given session.
 * Used to include workspaceId in status events so the frontend can match
 * by workspace ID directly (more reliable than current_session_id matching
 * which breaks when a new session is created or on app startup).
 */
export function lookupWorkspaceId(sessionId: string): string | null {
  const db = getDatabase();
  try {
    const row = db.prepare("SELECT workspace_id FROM sessions WHERE id = ?").get(sessionId) as
      | { workspace_id: string }
      | undefined;
    return row?.workspace_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up the agent_type for a given session.
 * Used to include the correct agentType in status events instead of
 * hardcoding "claude" (which would be wrong for Codex sessions).
 */
export function lookupAgentType(sessionId: string): AgentType {
  const db = getDatabase();
  try {
    const row = db.prepare("SELECT agent_type FROM sessions WHERE id = ?").get(sessionId) as
      | { agent_type: string }
      | undefined;
    return (row?.agent_type as AgentType) ?? "claude";
  } catch {
    return "claude";
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
// SessionStatus is now imported from shared/enums.ts (canonical 5-value enum)
// instead of the local 3-value definition that was missing "needs_response"
// and "needs_plan_response".

export function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  errorMessage?: string | null,
  errorCategory?: string | null
): WriteResult<void> {
  const t0 = Date.now();
  const db = getDatabase();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tUpdate = Date.now();
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
      const updateMs = Date.now() - tUpdate;

      const tNotify = Date.now();
      notifyBackend(NOTIFY_SESSION_STATUS, sessionId);
      const notifyMs = Date.now() - tNotify;

      // Emit to frontend via Tauri event (desktop path).
      // Fire-and-forget: tunnel may not be attached during startup
      // (reconcileStuckSessions) or after sidecar restart.
      try {
        const workspaceId = lookupWorkspaceId(sessionId);
        const agentType = lookupAgentType(sessionId);
        FrontendClient.sendStatusChanged({
          type: "status_changed",
          id: sessionId,
          agentType,
          status,
          ...(status === "error" && errorMessage ? { errorMessage } : {}),
          ...(status === "error" && errorCategory
            ? { errorCategory: errorCategory as ErrorCategory }
            : {}),
          ...(workspaceId ? { workspaceId } : {}),
        });
      } catch {
        // No tunnel attached — frontend will pick up via fallback poll
      }

      const totalMs = Date.now() - t0;
      console.log(
        `[TIMING][SESSION-WRITER] updateSessionStatus session=${sessionId} status='${status}' update=${updateMs}ms notify=${notifyMs}ms total=${totalMs}ms${attempt > 0 ? ` retries=${attempt}` : ""}${errorMessage ? ` error: ${errorMessage}` : ""}`
      );
      return { ok: true, value: undefined };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && (msg.includes("SQLITE_BUSY") || msg.includes("database is locked"))) {
        console.log(`[TIMING][SESSION-WRITER] SQLITE_BUSY on status update, retrying in 200ms...`);
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

// ── Context Usage ─────────────────────────────────────────────────────

/**
 * Update session's context token count and usage percentage.
 * Called after a turn completes when the SDK reports token usage.
 * The frontend reads these via useSession() — notifyBackend triggers
 * immediate React Query invalidation so the UI updates without polling.
 */
export function updateContextUsage(
  sessionId: string,
  tokenCount: number,
  usedPercent: number
): WriteResult<void> {
  const db = getDatabase();

  try {
    const result = db
      .prepare(
        `
      UPDATE sessions SET context_token_count = ?, context_used_percent = ?, updated_at = datetime('now') WHERE id = ?
    `
      )
      .run(tokenCount, usedPercent, sessionId);
    if (result.changes === 0) {
      console.warn(`[SESSION-WRITER] updateContextUsage: no session found for ${sessionId}`);
    }
    notifyBackend(NOTIFY_SESSION_UPDATED, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to update context usage:`, msg);
    return { ok: false, error: msg };
  }
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
    const row = db.prepare("SELECT agent_session_id FROM sessions WHERE id = ?").get(sessionId) as
      | { agent_session_id: string | null }
      | undefined;

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
    // Log the state of all sessions before reconciliation for debugging resume issues
    const allSessions = db
      .prepare(
        `SELECT id, status, agent_session_id, error_message, error_category
         FROM sessions ORDER BY updated_at DESC LIMIT 20`
      )
      .all() as Array<{
      id: string;
      status: string;
      agent_session_id: string | null;
      error_message: string | null;
      error_category: string | null;
    }>;

    console.log(
      `[SESSION-WRITER] Session state at startup (${allSessions.length} recent sessions):`
    );
    for (const s of allSessions) {
      console.log(
        `  [${s.id.substring(0, 8)}] status=${s.status} agent_session_id=${s.agent_session_id ?? "null"} error=${s.error_message ?? "none"} category=${s.error_category ?? "none"}`
      );
    }

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
      console.log(`[SESSION-WRITER] Reconciled ${count} stuck session(s) from 'working' to 'idle'`);
    }
    return { ok: true, value: count };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[SESSION-WRITER] Failed to reconcile stuck sessions:`, msg);
    return { ok: false, error: msg };
  }
}
