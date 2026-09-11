// Shared message projections: SQLite and the live query cache write the same rows.
import type {
  TurnProviderCredentialSource,
  TurnEndedEvent as CloudTurnEndedEvent,
} from "@deus-hq/api";
import type {
  ConversationCompaction,
  ConversationMessage,
  ConversationState,
  ConversationTurn,
} from "./protocol-types";
import { isUnknownEvent, type AnyLifecycleEvent } from "./protocol-types";
import type { Compaction, SessionTurn } from "./types/session";

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

/** AGNT's additive terminal field; the canonical engine fold owns execution. */
export function turnProviderCredentialSource(
  event: AnyLifecycleEvent
): TurnProviderCredentialSource | undefined {
  return !isUnknownEvent(event) && event.type === "turn.ended"
    ? (event as CloudTurnEndedEvent).providerCredentialSource
    : undefined;
}

/** The same turn record is written to SQLite and the live query cache.
 * A partial replay keeps facts it omits; an explicit redacted source replaces
 * the previous source as a whole, so private account details cannot linger. */
export function turnRecord(
  turn: ConversationTurn,
  providerCredentialSource?: TurnProviderCredentialSource,
  previous?: SessionTurn
): SessionTurn {
  return {
    turnId: turn.turnId,
    startedAt: previous?.startedAt ?? turn.startedAt,
    endedAt: turn.endedAt ?? previous?.endedAt,
    stopReason: turn.stopReason ?? previous?.stopReason,
    finishReason: turn.finishReason ?? previous?.finishReason,
    error: turn.error ?? previous?.error,
    execution: turn.execution ?? previous?.execution,
    providerCredentialSource: providerCredentialSource ?? previous?.providerCredentialSource,
    tokens: turn.tokens ?? previous?.tokens,
    cost: turn.cost ?? previous?.cost,
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
