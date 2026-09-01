// shared/conversation-rows.ts
// The rows an ended turn leaves behind — one implementation, two stores.
//
// The backend writes them to SQLite and the frontend mirrors them into the
// TanStack cache, and the two DEDUPLICATE against each other by a derived id
// (`cancelledTurnMessageId`). Two hand-synced answers to "what does a turn's
// end put on its last top-level assistant row" are therefore two writers of
// ONE row: they have to agree field for field, and they had already drifted —
// the cache defaulted a missing stopReason to "cancelled" and dropped
// tokens/cost from the minted marker entirely.
//
// So the rule lives here, once, as pure functions over the engine's own types.
// SQLite is the durable truth the cache must converge to, so these encode the
// SQL side's semantics: a field is `null` when the engine sent nothing, and
// the CALLER decides what null means for its store — the backend's
// `COALESCE(?, col)` keeps the column, the frontend's conditional spread keeps
// the cached value. `turn_stop_reason` is written unconditionally by both,
// because the turn's outcome is the turn's to state.
//
// Nothing here touches a database or a QueryClient: the backend binds the
// returned object to SQL placeholders, the frontend spreads it onto a row.

import type {
  ConversationCompaction,
  ConversationMessage,
  ConversationState,
  ConversationTurn,
} from "./protocol-types";
import { cancelledTurnMessageId, type Compaction, type Message } from "./types/session";

/**
 * The folded message a change addressed.
 *
 * Scanned from the END: the message being written is almost always the most
 * recent one, and the timeline holds compactions too, so the id lookup has to
 * narrow on `kind` either way.
 */
export function findConversationMessage(
  state: ConversationState,
  messageId: string
): ConversationMessage | undefined {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const entry = state.timeline[i];
    if (entry.kind === "message" && entry.messageId === messageId) return entry;
  }
  return undefined;
}

/**
 * The folded compaction a change addressed — the twin of
 * `findConversationMessage`, so both stores resolve a `compaction-upserted`
 * change to its entity the same way (the backend to persist it, the frontend
 * to mirror it into the cache).
 */
export function findConversationCompaction(
  state: ConversationState,
  compactionId: string
): ConversationCompaction | undefined {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const entry = state.timeline[i];
    if (entry.kind === "compaction" && entry.compactionId === compactionId) return entry;
  }
  return undefined;
}

/**
 * The four columns a finished turn stamps on its last top-level assistant
 * message, in `messages`-row spelling.
 *
 * `turn_stop_reason` is the TURN's outcome (the engine's `turn.ended`), not the
 * per-message stop-reason fiction the old schema carried — which is why
 * `refusal` and `max_turn_requests` survive a reload.
 */
export interface TurnAccountingRow {
  turn_stop_reason: string | null;
  /** JSON-encoded engine `TokenUsage`, or null when the turn carried none. */
  tokens: string | null;
  cost: number | null;
  cancelled_at: string | null;
}

/** The ISO stamp a turn ended at. `endedAt` is absent only mid-fold. */
function endedAtIso(turn: ConversationTurn): string {
  return new Date(turn.endedAt ?? Date.now()).toISOString();
}

/** The accounting an ended turn leaves on its last top-level assistant row. */
export function turnAccountingRow(turn: ConversationTurn): TurnAccountingRow {
  return {
    turn_stop_reason: turn.stopReason ?? null,
    tokens: turn.tokens ? JSON.stringify(turn.tokens) : null,
    cost: turn.cost ?? null,
    cancelled_at: turn.stopReason === "cancelled" ? endedAtIso(turn) : null,
  };
}

/**
 * The zero-part assistant row that says "this turn was interrupted".
 *
 * A turn cancelled before the model answered has no message to mark, so both
 * stores mint one. Session status alone cannot say it — `idle` after an
 * interrupt is indistinguishable from `idle` after nothing happened, and the
 * transcript would be silent about a turn the user explicitly stopped.
 *
 * The id is derived from the turn id, so a replayed `turn.ended` upserts the
 * same divider instead of stacking new ones, and the q:delta carrying the
 * persisted copy deduplicates against the mirrored one.
 *
 * `seq` is a placeholder: SQLite assigns the real one from its AFTER INSERT
 * trigger, and the cache keeps whatever the row already had.
 */
export function cancelledTurnRow(sessionId: string, turn: ConversationTurn): Message {
  const accounting = turnAccountingRow(turn);
  const at = accounting.cancelled_at ?? endedAtIso(turn);
  return {
    id: cancelledTurnMessageId(turn.turnId),
    session_id: sessionId,
    seq: 0,
    role: "assistant",
    turn_id: turn.turnId,
    model: null,
    sent_at: at,
    cancelled_at: at,
    turn_stop_reason: accounting.turn_stop_reason,
    tokens: accounting.tokens,
    cost: accounting.cost,
    parts: [],
  };
}

/**
 * The folded compaction entity → the `compactions` row shape both stores hold.
 *
 * The twin of `persistCompaction`'s INSERT: same columns, same spelling, so the
 * cache the direct lane writes and the SQLite row the backend writes are ONE
 * row. `created_at` anchors to the compaction's first `timestamp` (the backend
 * never moves it on later upserts); the optional token/summary fields are
 * OMITTED when the engine hasn't sent them, so a caller's COALESCE-merge keeps
 * whatever a prior event already set — the merge semantics the entity itself
 * documents (fields arrive across events; a later one that omits `summary` must
 * not erase it).
 */
export function compactionRow(sessionId: string, c: ConversationCompaction): Compaction {
  return {
    compaction_id: c.compactionId,
    session_id: sessionId,
    turn_id: c.turnId,
    status: c.status,
    ...(c.trigger !== undefined && { trigger: c.trigger }),
    ...(c.preTokens !== undefined && { pre_tokens: c.preTokens }),
    ...(c.postTokens !== undefined && { post_tokens: c.postTokens }),
    ...(c.summary !== undefined && { summary: c.summary }),
    created_at: new Date(c.timestamp).toISOString(),
  };
}
