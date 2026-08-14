/**
 * The chat timeline: turns, plus the compaction markers between them.
 *
 * A compaction is not a message and not a part — it is a positional entity
 * (protocol §5) that belongs BETWEEN the turn it was emitted during and that
 * turn's successor. Placement is by `turn_id`, so a reload lands the divider
 * in the same slot the live stream did.
 */

import { match } from "ts-pattern";
import type { Compaction, Message } from "../types";

export type UserTurn = {
  type: "user";
  message: Message;
  messageIndex: number;
};

export type AssistantTurnData = {
  type: "assistant";
  messages: Message[];
  firstMessageIndex: number;
  isLatest: boolean;
  startedAt: string | null;
};

export type Turn = UserTurn | AssistantTurnData;

export type CompactionMarker = {
  type: "compaction";
  compaction: Compaction;
};

export type ChatTimelineItem = Turn | CompactionMarker;

/**
 * Splice compaction markers into the turn list at their anchor position.
 *
 * Anchor rules, in order:
 *   1. The LAST turn holding the compaction's `turn_id` — a compaction fires
 *      mid-turn, so it renders once that turn is closed.
 *   2. No such turn loaded (paginated away, or the marker beat its turn's
 *      first message): fall back to `created_at` against turn end times.
 *   3. Older than everything loaded: emit above the first turn.
 *
 * Markers are never dropped — a divider that vanishes is worse than one an
 * approximate slot away.
 */
export function insertCompactions(
  turns: Turn[],
  compactions: readonly Compaction[]
): ChatTimelineItem[] {
  if (compactions.length === 0) return turns;

  // Turn index each `turn_id` last appears at, and when each turn ended.
  const anchorByTurnId = new Map<string, number>();
  const turnEndedAt: number[] = [];
  turns.forEach((turn, index) => {
    let endedAt = Number.NaN;
    for (const message of turn.type === "user" ? [turn.message] : turn.messages) {
      if (message.turn_id) anchorByTurnId.set(message.turn_id, index);
      const sentAt = message.sent_at ? Date.parse(message.sent_at) : Number.NaN;
      if (Number.isFinite(sentAt))
        endedAt = Number.isFinite(endedAt) ? Math.max(endedAt, sentAt) : sentAt;
    }
    turnEndedAt.push(endedAt);
  });

  // Turn index → markers emitted after it. -1 means "above the first turn".
  const afterTurn = new Map<number, Compaction[]>();
  for (const compaction of [...compactions].sort(byCreatedAt)) {
    if (!isRenderable(compaction)) continue;
    const anchor =
      anchorByTurnId.get(compaction.turn_id) ?? fallbackAnchor(turnEndedAt, compaction);
    const bucket = afterTurn.get(anchor);
    if (bucket) bucket.push(compaction);
    else afterTurn.set(anchor, [compaction]);
  }
  if (afterTurn.size === 0) return turns;

  const timeline: ChatTimelineItem[] = [];
  const emit = (index: number) => {
    for (const compaction of afterTurn.get(index) ?? [])
      timeline.push({ type: "compaction", compaction });
  };

  emit(-1);
  turns.forEach((turn, index) => {
    timeline.push(turn);
    emit(index);
  });
  return timeline;
}

function byCreatedAt(a: Compaction, b: Compaction): number {
  return a.created_at.localeCompare(b.created_at);
}

/** A cancelled compaction never happened — nothing to tell the reader. */
function isRenderable(compaction: Compaction): boolean {
  return compaction.status !== "cancelled";
}

function fallbackAnchor(turnEndedAt: readonly number[], compaction: Compaction): number {
  const createdAt = Date.parse(compaction.created_at);
  if (!Number.isFinite(createdAt)) return turnEndedAt.length - 1;

  let anchor = -1;
  for (let index = 0; index < turnEndedAt.length; index++) {
    const endedAt = turnEndedAt[index];
    if (Number.isFinite(endedAt) && endedAt <= createdAt) anchor = index;
  }
  return anchor;
}

/**
 * The chip's one line. `status` is an OPEN enum (protocol §3), so unknown
 * values read as the completed case rather than rendering nothing.
 */
export function compactionLabel(compaction: Compaction): string {
  return match(compaction.status)
    .with("in_progress", () => "Compacting")
    .with("failed", () => "Compaction failed")
    .otherwise(() => (compaction.trigger === "auto" ? "Auto-compacted" : "Compacted"));
}

/** "78k → 31k tokens" — the muted suffix, or null when the engine didn't report. */
export function compactionTokenLabel(compaction: Compaction): string | null {
  const { pre_tokens: pre, post_tokens: post } = compaction;
  if (pre == null || post == null) return null;
  return `${formatTokens(pre)} → ${formatTokens(post)} tokens`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
