// backend/src/services/agent/persistence.ts
// Database writes for the canonical @zvada/agent-server conversation.
//
// Every function here takes a value the ENGINE's fold produced — a
// `ConversationMessage`, a `Part`, a `ConversationTurn` — not an event and
// certainly not a deus dialect. `parts.data` is the engine `Part` verbatim.
// What stays deus's is the SQL: ON CONFLICT vs REPLACE, which columns each row
// owns, the COALESCE guards. That is schema knowledge, and no fold has an
// opinion about it.
//
// `persistChanges` is the entry point: the reducer says WHAT moved (addressed
// by wire ids), this says which rows that implies. Redelivery mostly folds to
// NOTHING (a replayed message.started, turn.started, turn.ended or
// message.ended reports no change), so most replay-safety is structural. The
// exception is a part SNAPSHOT: the reducer never compares snapshots, it
// upserts them, so a replayed one is reported and re-written — which is why
// the parts statement is an idempotent upsert and not an insert.
//
// All functions are synchronous (better-sqlite3 is synchronous) and never
// throw: they return a WriteResult so the caller decides whether to invalidate.

import type {
  ConversationChange,
  ConversationCompaction,
  ConversationMessage,
  ConversationState,
  ConversationTurn,
  Part,
  UnknownPart,
} from "@zvada/agent-server/protocol";
import { isUnknownPart } from "@shared/protocol-types";
import { getDatabase } from "../../lib/database";
import { getErrorMessage } from "@shared/lib/errors";
import { cancelledTurnMessageId } from "@shared/types/session";

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
 * Mint the row for a folded message.
 *
 * This is the ONLY writer of message rows — the user echo included. Deus does
 * not insert the user's message when the composer sends: the engine echoes it
 * back (role "user", outputIndex 0) and that echo is the persistence source of
 * truth, so a user row and an assistant row are produced by the same code path
 * with the same turn grouping.
 *
 * The upsert is ON CONFLICT, never INSERT OR REPLACE: SQLite's REPLACE is
 * DELETE + INSERT, which would cascade-delete the message's parts, reassign
 * its `seq` (AFTER INSERT trigger) to the end of the transcript, inflate
 * `message_count` (the AFTER DELETE trigger does not fire under REPLACE) and
 * wipe every column written after the message started — tokens, cost,
 * turn_stop_reason, cancelled_at. Within one process the fold makes a replayed
 * `message.started` report nothing, so this rarely runs twice — but after a
 * BACKEND RESTART the fold begins empty while SQLite remembers everything, and
 * the first replayed message of a resumed session lands here as a genuine
 * upsert. COALESCE guards the fields a thinner replay omits.
 */
export function persistMessage(sessionId: string, message: ConversationMessage): WriteResult {
  const db = getDatabase();
  try {
    // A message for a session we don't know about has no FK target; the parts
    // that follow would fail too. Skip loudly instead of throwing per part.
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId);
    if (!session) {
      console.warn(`[AgentPersistence] message: session ${sessionId} not found, skipping`);
      return { ok: false, error: "session not found" };
    }

    db.prepare(
      `INSERT INTO messages (id, session_id, role, turn_id, model, sent_at, parent_tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         turn_id = excluded.turn_id,
         model = COALESCE(excluded.model, messages.model),
         sent_at = COALESCE(excluded.sent_at, messages.sent_at),
         parent_tool_call_id = COALESCE(excluded.parent_tool_call_id, messages.parent_tool_call_id)`
    ).run(
      message.messageId,
      sessionId,
      message.role,
      message.turnId,
      message.model ?? null,
      iso(message.startedAt),
      message.parentToolCallId ?? null
    );
    return { ok: true, value: message.messageId };
  } catch (error) {
    return failed("message", error);
  }
}

/**
 * The tool columns, promoted out of `data` for indexed lookups. An UNKNOWN
 * part (Law 6) has no known fields to promote — it is stored verbatim and
 * queried by nothing.
 */
function toolColumns(part: Part | UnknownPart): {
  toolCallId: string | null;
  toolName: string | null;
} {
  if (isUnknownPart(part) || part.type !== "tool") return { toolCallId: null, toolName: null };
  return { toolCallId: part.toolCallId, toolName: part.toolName };
}

/**
 * Upsert a part. The folded part is authoritative and idempotent (UPSERT by
 * part id), so INSERT OR REPLACE is the exact match for its semantics —
 * including a tool part completing after its message ended, which names its
 * ORIGINAL messageId and lands back there, and a cancelled turn's closure
 * rewriting a still-open tool. Unlike `messages`, a `parts` row owns every one
 * of its columns, so REPLACE has nothing to lose and nothing cascades off it.
 *
 * `seq` mirrors the change's `partIndex`: parts carry no ordering field of
 * their own, position is the stream's knowledge.
 */
export function persistPart(
  sessionId: string,
  messageId: string,
  part: Part | UnknownPart,
  partIndex: number
): WriteResult {
  const db = getDatabase();
  try {
    const tool = toolColumns(part);
    db.prepare(
      `INSERT OR REPLACE INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name, parent_tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      part.id,
      messageId,
      sessionId,
      partIndex,
      part.type,
      JSON.stringify(part),
      tool.toolCallId,
      tool.toolName,
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
    return failed("part", error);
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
 * A turn cancelled before the model answered has no message to mark, so this
 * mints one: a zero-part assistant row carrying only `cancelled_at` and the
 * stop reason. Session status alone cannot say it — `idle` after an interrupt
 * is indistinguishable from `idle` after nothing happened, and the transcript
 * would be silent about a turn the user explicitly stopped. The id is derived
 * from the turn id (`cancelledTurnMessageId`), so a replayed `turn.ended`
 * upserts the same divider instead of stacking new ones.
 */
export function persistTurnEnded(
  sessionId: string,
  turn: ConversationTurn,
  outcome: TurnOutcomeWrite
): WriteResult<void> {
  const db = getDatabase();
  const endedAt = iso(turn.endedAt ?? Date.now());
  try {
    db.transaction(() => {
      const target = db
        .prepare(
          `SELECT id FROM messages
           WHERE session_id = ? AND turn_id = ? AND role = 'assistant' AND parent_tool_call_id IS NULL
           ORDER BY seq DESC LIMIT 1`
        )
        .get(sessionId, turn.turnId) as { id: string } | undefined;

      if (target) {
        db.prepare(
          `UPDATE messages
             SET tokens = COALESCE(?, tokens),
                 cost = COALESCE(?, cost),
                 turn_stop_reason = ?,
                 cancelled_at = COALESCE(?, cancelled_at)
           WHERE id = ?`
        ).run(
          turn.tokens ? JSON.stringify(turn.tokens) : null,
          turn.cost ?? null,
          turn.stopReason ?? null,
          outcome.cancelled ? endedAt : null,
          target.id
        );
      } else if (outcome.cancelled) {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, turn_id, sent_at, cancelled_at, turn_stop_reason, tokens, cost)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             cancelled_at = excluded.cancelled_at,
             turn_stop_reason = excluded.turn_stop_reason,
             tokens = COALESCE(excluded.tokens, messages.tokens),
             cost = COALESCE(excluded.cost, messages.cost)`
        ).run(
          cancelledTurnMessageId(turn.turnId),
          sessionId,
          turn.turnId,
          endedAt,
          endedAt,
          turn.stopReason ?? null,
          turn.tokens ? JSON.stringify(turn.tokens) : null,
          turn.cost ?? null
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
        ).run(outcome.error?.message ?? null, outcome.error?.category ?? null, sessionId);
      } else {
        db.prepare(
          `UPDATE sessions SET status = 'idle', error_message = NULL, error_category = NULL, updated_at = datetime('now')
           WHERE id = ?`
        ).run(sessionId);
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
export function persistSessionUsage(
  sessionId: string,
  usage: NonNullable<ConversationState["usage"]>
): WriteResult<void> {
  const db = getDatabase();
  try {
    // Claude reports `used` on every model message but `size` only on the
    // final result, and codex-sdk never reports size at all. The FOLD is the
    // sticky merge now — `usage.size` is the last size it saw this process.
    //
    // The COALESCE stays, for a case the fold cannot cover: after a backend
    // restart the fold begins empty, so the first size-less usage event of a
    // resumed session would zero a percent the DB still knows. In-memory
    // stickiness is per-process; the column's is durable.
    const percent = usage.size ? Math.min((usage.used / usage.size) * 100, 100) : null;
    db.prepare(
      `UPDATE sessions
         SET context_token_count = ?, context_used_percent = COALESCE(?, context_used_percent),
             updated_at = datetime('now')
       WHERE id = ?`
    ).run(usage.used, percent, sessionId);
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
export function persistCompaction(
  sessionId: string,
  compaction: ConversationCompaction
): WriteResult {
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
      compaction.compactionId,
      sessionId,
      compaction.turnId,
      compaction.status,
      compaction.trigger ?? null,
      compaction.preTokens ?? null,
      compaction.postTokens ?? null,
      compaction.summary ?? null,
      iso(compaction.timestamp)
    );
    return { ok: true, value: compaction.compactionId };
  } catch (error) {
    return failed("session.compaction", error);
  }
}

// ============================================================================
// The change loop
// ============================================================================

/** One row write the fold's changes implied, for a caller that logs or counts. */
export interface ChangeWrite {
  kind: ConversationChange["kind"];
  /** Human-readable subject, for the verification CLI's log line. */
  detail: string;
  result: WriteResult<unknown>;
}

/**
 * Turn the reducer's changes into row writes.
 *
 * The `changes` say what moved and address it by wire id; `state` holds the
 * values. Everything not listed here is deliberately not a row: a bracket
 * marker (`message-ended`), streamed tool input (`delta-buffered` — the
 * snapshot that follows is what gets stored), permissions (deus answers them
 * in-process and has no prompt to render), and the session-scoped facts the
 * caller writes itself because they carry product state (`session-meta-updated`
 * → agent_session_id, `session-ended`).
 *
 * `outcomeFor` is the caller's: an ended turn's terminal state depends on
 * whether deus already reported an error for it, which is session bookkeeping
 * the fold has no opinion about.
 */
export function persistChanges(
  sessionId: string,
  state: ConversationState,
  changes: ConversationChange[],
  outcomeFor: (turn: ConversationTurn) => TurnOutcomeWrite
): ChangeWrite[] {
  const writes: ChangeWrite[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "message-upserted": {
        const message = findMessage(state, change.messageId);
        if (!message) break;
        writes.push({
          kind: change.kind,
          detail: `${message.role} messageId=${message.messageId}`,
          result: persistMessage(sessionId, message),
        });
        break;
      }
      case "part-upserted": {
        const message = findMessage(state, change.messageId);
        const part = message?.parts.find((p) => p.id === change.partId);
        if (!part) break;
        writes.push({
          kind: change.kind,
          detail: `${part.type} partId=${part.id}`,
          result: persistPart(sessionId, change.messageId, part, change.partIndex),
        });
        break;
      }
      case "turn-updated": {
        const turn = state.turns.find((t) => t.turnId === change.turnId);
        // `turn-updated` also reports a turn OPENING and a non-terminal error
        // attributed to one — neither leaves accounting behind.
        if (!turn || turn.status !== "ended") break;
        writes.push({
          kind: change.kind,
          detail: `turn=${turn.turnId} stopReason=${turn.stopReason ?? "?"}`,
          result: persistTurnEnded(sessionId, turn, outcomeFor(turn)),
        });
        break;
      }
      case "usage-updated": {
        // Also emitted when an ended turn's billing rolls into the totals,
        // which moves no session column.
        if (!state.usage) break;
        writes.push({
          kind: change.kind,
          detail: `used=${state.usage.used}${state.usage.size ? `/${state.usage.size}` : ""}`,
          result: persistSessionUsage(sessionId, state.usage),
        });
        break;
      }
      case "compaction-upserted": {
        const entry = state.timeline.find(
          (e): e is ConversationCompaction =>
            e.kind === "compaction" && e.compactionId === change.compactionId
        );
        if (!entry) break;
        writes.push({
          kind: change.kind,
          detail: `compactionId=${entry.compactionId} status=${entry.status}`,
          result: persistCompaction(sessionId, entry),
        });
        break;
      }
      default:
        break;
    }
  }
  return writes;
}

function findMessage(state: ConversationState, messageId: string): ConversationMessage | undefined {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const entry = state.timeline[i];
    if (entry.kind === "message" && entry.messageId === messageId) return entry;
  }
  return undefined;
}
