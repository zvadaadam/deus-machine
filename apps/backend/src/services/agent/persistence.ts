// backend/src/services/agent/persistence.ts
// Database writes for the canonical @zvada/agent-server lifecycle stream.
//
// Every function here takes the engine's own event shape — there is no deus
// dialect between the wire and SQLite. `parts.data` is the engine `Part`
// verbatim; `messages` rows are minted from `message.started` (including the
// user echo); turn accounting lands on `turn.ended`.
//
// All functions are synchronous (better-sqlite3 is synchronous) and never
// throw: they return a WriteResult so the caller decides whether to invalidate.

import type {
  MessagePartEvent,
  MessageStartedEvent,
  SessionCompactionEvent,
  SessionUsageEvent,
  TurnEndedEvent,
} from "@zvada/agent-server/protocol";
import { getDatabase } from "../../lib/database";
import { getErrorMessage } from "@shared/lib/errors";

// ============================================================================
// WriteResult
// ============================================================================

export type WriteResult<T = string> = { ok: true; value: T } | { ok: false; error: string };

function failed(what: string, error: unknown): WriteResult<never> {
  const message = getErrorMessage(error);
  console.error(`[AgentPersistence] Failed to persist ${what}:`, message);
  return { ok: false, error: message };
}

/** Epoch-ms (protocol time) → the ISO strings every timestamp column stores. */
function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// ============================================================================
// Messages + parts
// ============================================================================

/**
 * Mint the message row for an engine `message.started`.
 *
 * This is the ONLY writer of message rows — the user echo included. Deus no
 * longer inserts the user's message when the composer sends: the engine echoes
 * it back (role "user", outputIndex 0) and that echo is the persistence source
 * of truth, so a user row and an assistant row are produced by the same code
 * path with the same turn grouping.
 *
 * INSERT OR REPLACE keeps a replayed event idempotent, but the message id is
 * the engine's, so a replay rewrites the same row rather than duplicating it.
 * `content` stays NULL: new rows render from their parts.
 */
export function persistMessageStarted(event: MessageStartedEvent): WriteResult {
  const db = getDatabase();
  try {
    // A message for a session we don't know about has no FK target; the parts
    // that follow would fail too. Skip loudly instead of throwing per part.
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(event.sessionId);
    if (!session) {
      console.warn(
        `[AgentPersistence] message.started: session ${event.sessionId} not found, skipping`
      );
      return { ok: false, error: "session not found" };
    }

    db.prepare(
      `INSERT OR REPLACE INTO messages (id, session_id, role, turn_id, model, sent_at, parent_tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.messageId,
      event.sessionId,
      event.role,
      event.turnId,
      event.model ?? null,
      iso(event.timestamp),
      event.parentToolCallId ?? null
    );
    return { ok: true, value: event.messageId };
  } catch (error) {
    return failed("message.started", error);
  }
}

/**
 * Upsert a part snapshot. The engine's `message.part` is authoritative and
 * idempotent (UPSERT by part id), so INSERT OR REPLACE is the exact match for
 * its semantics — including a tool part completing after its message ended,
 * which names its ORIGINAL messageId and lands back there.
 *
 * `seq` mirrors the event's `partIndex`: parts carry no ordering field of
 * their own, position is the event's knowledge.
 */
export function persistPart(event: MessagePartEvent): WriteResult {
  const db = getDatabase();
  const part = event.part;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name, parent_tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      part.id,
      event.messageId,
      event.sessionId,
      event.partIndex,
      part.type,
      JSON.stringify(part),
      part.type === "tool" ? part.toolCallId : null,
      part.type === "tool" ? part.toolName : null,
      part.parentToolCallId ?? null
    );
    return { ok: true, value: part.id };
  } catch (error) {
    const message = getErrorMessage(error);
    // A part can outrun its message row (the session lookup above rejected it,
    // or the events crossed). The next snapshot re-upserts, so this is not a
    // data loss worth shouting about.
    if (message.includes("FOREIGN KEY")) {
      return { ok: true, value: part.id };
    }
    return failed("message.part", error);
  }
}

// ============================================================================
// Turn outcome
// ============================================================================

export interface TurnOutcomeWrite {
  /** Session status to leave behind. */
  status: "idle" | "error";
  /** Set when status is "error". */
  error?: { message: string; category: string };
  /** Stamp cancelled_at on the turn's last assistant message. */
  cancelled: boolean;
}

/**
 * Persist everything a finished turn leaves behind, in one transaction:
 * the turn's billing totals + terminal stopReason on its last top-level
 * assistant message, the cancellation marker, and the session's new status.
 *
 * Tokens and cost used to be computed end-to-end and then dropped on the
 * floor; they are columns now. `turn_stop_reason` is the TURN's outcome (the
 * engine's `turn.ended.stopReason`) — not the per-message stop-reason fiction
 * the old schema carried, which is why `refusal` and `max_turn_requests`
 * finally survive a reload.
 *
 * A turn that produced no assistant message (cancelled before the model
 * answered) has nothing to mark; the session status is still written.
 */
export function persistTurnEnded(
  event: TurnEndedEvent,
  outcome: TurnOutcomeWrite
): WriteResult<void> {
  const db = getDatabase();
  try {
    db.transaction(() => {
      const target = db
        .prepare(
          `SELECT id FROM messages
           WHERE session_id = ? AND turn_id = ? AND role = 'assistant' AND parent_tool_call_id IS NULL
           ORDER BY seq DESC LIMIT 1`
        )
        .get(event.sessionId, event.turnId) as { id: string } | undefined;

      if (target) {
        db.prepare(
          `UPDATE messages
             SET tokens = COALESCE(?, tokens),
                 cost = COALESCE(?, cost),
                 turn_stop_reason = ?,
                 cancelled_at = COALESCE(?, cancelled_at)
           WHERE id = ?`
        ).run(
          event.tokens ? JSON.stringify(event.tokens) : null,
          event.cost ?? null,
          event.stopReason,
          outcome.cancelled ? iso(event.timestamp) : null,
          target.id
        );
      }

      if (outcome.status === "error") {
        // No ErrorInfo means a standalone `error` event already wrote the
        // specific message — COALESCE keeps it instead of replacing it with
        // the terminal event's vaguer wording.
        db.prepare(
          `UPDATE sessions
             SET status = 'error',
                 error_message = COALESCE(?, error_message, 'Agent turn failed'),
                 error_category = COALESCE(?, error_category, 'internal'),
                 updated_at = datetime('now')
           WHERE id = ?`
        ).run(outcome.error?.message ?? null, outcome.error?.category ?? null, event.sessionId);
      } else {
        db.prepare(
          `UPDATE sessions SET status = 'idle', error_message = NULL, error_category = NULL, updated_at = datetime('now')
           WHERE id = ?`
        ).run(event.sessionId);
      }
    })();
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("turn.ended", error);
  }
}

// ============================================================================
// Session state
// ============================================================================

/**
 * Optimistic "the agent is working" flip, written by the send command before
 * the wire ack. The engine has no event for it (a turn is admitted, not
 * "started" by the product) — deus owns this transition.
 */
export function persistSessionWorking(sessionId: string, sentAt: string): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions
         SET status = 'working', last_user_message_at = ?, error_message = NULL, error_category = NULL,
             updated_at = datetime('now')
       WHERE id = ?`
    ).run(sentAt, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session working", error);
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
    return failed("needs_plan_response", error);
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
    return failed("needs_response", error);
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
    return failed("working status", error);
  }
}

/** Persist the live context gauge onto the session row (composer indicator). */
export function persistSessionUsage(event: SessionUsageEvent): WriteResult<void> {
  const db = getDatabase();
  try {
    // Claude reports `used` on every model message but `size` only on the
    // final result — a size-less event must not zero the percent mid-turn
    // (and codex-sdk never reports size at all). The COALESCE is the whole
    // sticky merge; there is no second merge in memory anymore.
    const percent = event.size ? Math.min((event.used / event.size) * 100, 100) : null;
    db.prepare(
      `UPDATE sessions
         SET context_token_count = ?, context_used_percent = COALESCE(?, context_used_percent),
             updated_at = datetime('now')
       WHERE id = ?`
    ).run(event.used, percent, event.sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session.usage", error);
  }
}

/** Update session status to "error" with error details. */
export function persistSessionError(
  sessionId: string,
  message: string,
  category: string
): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET status = 'error', error_message = ?, error_category = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(message, category, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session error", error);
  }
}

// ============================================================================
// Metadata
// ============================================================================

/** Store the harness-native session id so the next turn can resume it. */
export function persistAgentSessionId(
  sessionId: string,
  nativeSessionId: string
): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(nativeSessionId, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session.created", error);
  }
}

/** Update session title and auto-set workspace title if not already set. */
export function persistSessionTitle(sessionId: string, title: string): WriteResult<void> {
  const db = getDatabase();
  try {
    db.transaction(() => {
      db.prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(
        title,
        sessionId
      );
      // Auto-set workspace title only if not already set (preserves PR titles and user renames)
      db.prepare(
        `UPDATE workspaces SET title = ?
         WHERE id = (SELECT workspace_id FROM sessions WHERE id = ?)
         AND title IS NULL`
      ).run(title, sessionId);
    })();
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session title", error);
  }
}

/**
 * Upsert the compaction entity. It is ID-addressed and positional: the first
 * event anchors it (created_at), later upserts advance status/summary/tokens
 * without moving it, so the divider keeps its place in a replayed transcript.
 */
export function persistCompaction(event: SessionCompactionEvent): WriteResult {
  const db = getDatabase();
  try {
    db.prepare(
      `INSERT INTO compactions (compaction_id, session_id, turn_id, status, trigger, pre_tokens, post_tokens, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(compaction_id) DO UPDATE SET
         status = excluded.status,
         trigger = COALESCE(excluded.trigger, compactions.trigger),
         pre_tokens = COALESCE(excluded.pre_tokens, compactions.pre_tokens),
         post_tokens = COALESCE(excluded.post_tokens, compactions.post_tokens),
         summary = COALESCE(excluded.summary, compactions.summary)`
    ).run(
      event.compactionId,
      event.sessionId,
      event.turnId,
      event.status,
      event.trigger ?? null,
      event.preTokens ?? null,
      event.postTokens ?? null,
      event.summary ?? null,
      iso(event.timestamp)
    );
    return { ok: true, value: event.compactionId };
  } catch (error) {
    return failed("session.compaction", error);
  }
}
