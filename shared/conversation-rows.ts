// Shared message projections: SQLite and the live query cache write the same rows.
import type {
  TurnProviderCredentialSource,
  TurnEndedEvent as CloudTurnEndedEvent,
  TurnExecution,
} from "@deus-hq/api";
import type {
  ConversationCompaction,
  ConversationMessage,
  ConversationState,
  ConversationTurn,
} from "./protocol-types";
import { isUnknownEvent, type AnyLifecycleEvent } from "./protocol-types";
import { turnOutcomeMessageId, type Compaction, type Message } from "./types/session";

/** Anchor generated outcomes after their turn's last saved row, before later turns. */
export function transcriptOrderRanks(
  rows: ReadonlyArray<{ id: string; turn_id?: string | null }>,
  orderedIds: readonly string[]
): Map<string, number> {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  const lastInTurn = new Map<string, number>();
  for (const row of rows) {
    const index = rank.get(row.id);
    if (row.turn_id && index !== undefined)
      lastInTurn.set(row.turn_id, Math.max(lastInTurn.get(row.turn_id) ?? -1, index));
  }
  for (const row of rows) {
    if (row.turn_id && !rank.has(row.id) && row.id === turnOutcomeMessageId(row.turn_id)) {
      const anchor = lastInTurn.get(row.turn_id);
      if (anchor !== undefined) rank.set(row.id, anchor + 0.5);
    }
  }
  return rank;
}

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
 * The columns a finished turn stamps on its last top-level assistant
 * message, in `messages`-row spelling.
 *
 * `turn_stop_reason` is the TURN's outcome (the engine's `turn.ended`), not the
 * per-message stop-reason fiction the old schema carried — which is why
 * `refusal` and `max_turn_requests` survive a reload.
 */
export interface TurnAccountingRow {
  turn_stop_reason: string | null;
  turn_attribution: string | null;
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
export interface TurnAttribution {
  execution?: TurnExecution;
  providerCredentialSource?: TurnProviderCredentialSource;
}

/** AGNT's additive terminal field; the canonical engine fold owns execution. */
export function turnProviderCredentialSource(
  event: AnyLifecycleEvent
): TurnProviderCredentialSource | undefined {
  return !isUnknownEvent(event) && event.type === "turn.ended"
    ? (event as CloudTurnEndedEvent).providerCredentialSource
    : undefined;
}

export function turnAccountingRow(
  turn: ConversationTurn,
  providerCredentialSource?: TurnProviderCredentialSource,
  previousAttribution?: string | null
): TurnAccountingRow {
  const previous: TurnAttribution | undefined = previousAttribution
    ? JSON.parse(previousAttribution)
    : undefined;
  const execution = turn.execution ?? previous?.execution;
  const source = providerCredentialSource ?? previous?.providerCredentialSource;
  return {
    turn_stop_reason: turn.stopReason ?? null,
    turn_attribution:
      execution || source
        ? JSON.stringify({
            ...(execution && { execution }),
            ...(source && { providerCredentialSource: source }),
          } satisfies TurnAttribution)
        : null,
    tokens: turn.tokens ? JSON.stringify(turn.tokens) : null,
    cost: turn.cost ?? null,
    cancelled_at: turn.stopReason === "cancelled" ? endedAtIso(turn) : null,
  };
}

/** An ended turn without assistant output still needs a durable footer/outcome. */
export function turnOutcomeRow(
  sessionId: string,
  turn: ConversationTurn,
  providerCredentialSource?: TurnProviderCredentialSource
): Message {
  const accounting = turnAccountingRow(turn, providerCredentialSource);
  const at = accounting.cancelled_at ?? endedAtIso(turn);
  return {
    id: turnOutcomeMessageId(turn.turnId),
    session_id: sessionId,
    seq: 0,
    role: "assistant",
    turn_id: turn.turnId,
    model: null,
    sent_at: at,
    cancelled_at: accounting.cancelled_at,
    turn_stop_reason: accounting.turn_stop_reason,
    turn_attribution: accounting.turn_attribution,
    tokens: accounting.tokens,
    cost: accounting.cost,
    parts: [],
  };
}

/** A recovered assistant answer replaces the marker minted before it was known. */
export function supersededOutcomeMarkers(state: ConversationState): Set<string> {
  const ids = new Set<string>();
  for (const entry of state.timeline) {
    if (entry.kind === "message" && entry.role === "assistant" && !entry.parentToolCallId) {
      ids.add(turnOutcomeMessageId(entry.turnId));
    }
  }
  return ids;
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
