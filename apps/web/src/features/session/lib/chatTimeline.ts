/**
 * The chat timeline: everything `<Chat>` renders, derived from the rows it was
 * given. Turns, the compaction markers between them, the padding each slot
 * gets, and what the agent is doing right now.
 *
 * A compaction is not a message and not a part — it is a positional entity
 * (protocol §5) that belongs BETWEEN the turn it was emitted during and that
 * turn's successor. Placement is by `turn_id`, so a reload lands the divider
 * in the same slot the live stream did.
 *
 * All of it used to be a four-stage `useMemo` chain inside the component —
 * pure functions of props, held in the reader's head, and untestable without
 * React. `buildChatTimeline` is that chain, once: Chat renders, this derives.
 */

import { match } from "ts-pattern";
import {
  agentActivity,
  groupIntoTurns,
  type AgentActivity,
} from "@zvada/agent-server/protocol/selectors";
import type { ConversationState } from "@shared/protocol-types";
import { cn } from "@/shared/lib/utils";
import { conversationView } from "./conversationView";
import type { Compaction, Message, MessageRole } from "../types";

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

/** Everything the chat needs to render one session's transcript. */
export interface ChatTimeline {
  /** Turns and compaction markers, in render order. */
  items: ChatTimelineItem[];
  /** The padding class for each slot, index-aligned with `items`. */
  spacings: string[];
  /** What the agent is doing right now — the activity indicator's variant. */
  activity: AgentActivity;
  /** The last RENDERED message's role, for the indicator's top margin. */
  lastRole: MessageRole | null;
}

/**
 * Rows → the timeline, in the four steps the component used to hold:
 * filter what renders, read it back as the engine's conversation, group it
 * into turns, splice the compactions in and pre-compute the spacing.
 *
 * `working` is deus's, not the stream's: it comes from `sessions.status`, and
 * `conversationView` needs it to mark the last turn active — without it every
 * turn reads as ended and `agentActivity` can only ever answer "idle".
 */
export function buildChatTimeline(
  messages: Message[],
  compactions: readonly Compaction[],
  working: boolean
): ChatTimeline {
  const rendered = renderableMessages(messages);
  const conversation = conversationView(rendered, working);
  const items = insertCompactions(groupTurns(conversation, rendered), compactions);

  return {
    items,
    spacings: items.map((item, i) =>
      turnSpacingClasses(item, items[i - 1] ?? null, items[i + 1] ?? null, i === 0)
    ),
    activity: agentActivity(conversation),
    lastRole: rendered.length ? rendered[rendered.length - 1].role : null,
  };
}

/** Subagent children render nested under their Task tool block, never inline. */
function renderableMessages(messages: Message[]): Message[] {
  return messages.filter((message) => {
    if (message.parent_tool_call_id) return false;
    // User messages always render.
    if (message.role === "user") return true;
    // Assistant messages with parts render.
    if (message.parts && message.parts.length > 0) return true;
    // Keep cancelled messages for the "Response stopped" badge.
    if (message.cancelled_at) return true;
    // Keep a row whose TURN ended with something to say. A model can open an
    // assistant message and end on `refusal` / `max_tokens` /
    // `max_turn_requests` without emitting a single part: that row is the only
    // record of the outcome, so dropping it renders a refusal as a prompt
    // followed by a silently idle session.
    if (turnStopNotice(message.turn_stop_reason)) return true;
    // Skip empty ones: `message.started` arrived but no parts yet — the row
    // appears as soon as one does.
    return false;
  });
}

/**
 * The one line a terminal stop reason owes the reader, or null when the turn
 * ended the ordinary way (`end_turn`) and needs no explanation.
 *
 * This is the SAME predicate the filter above uses to keep an empty row and
 * `AssistantTurn` uses to render the notice on it — one rule, so a reason can
 * never be retained with nothing to show, or shown on a row that was dropped.
 *
 * `cancelled` is deliberately absent: it has its own "Response stopped" badge,
 * anchored on `cancelled_at`. `error` is too — the session goes to the error
 * status and the error surface owns that story. Stop reasons are an OPEN
 * vocabulary (protocol §3), so an unrecognized one falls through to null
 * rather than inventing copy for an outcome this build cannot interpret.
 */
export function turnStopNotice(reason: string | null | undefined): string | null {
  return match(reason)
    .with("refusal", () => "The model declined to continue this response.")
    .with(
      "max_turn_requests",
      () => "The agent hit its request limit for this turn — send a follow-up to continue."
    )
    .with("max_tokens", () => "The response hit the model's output limit and was truncated.")
    .otherwise(() => null);
}

/**
 * Group consecutive messages into turns.
 *
 * The boundaries are the engine's: a run breaks when the speaker or the turn
 * changes, and `isLatest` is set on the FINAL group only — the guard that
 * keeps a finished turn out of streaming mode in the gap between "user sends"
 * and "first assistant part arrives" (without it, the completed answer above
 * visibly reverts to "working").
 *
 * The groups come back in order, so each is a contiguous SLICE of `rendered`
 * and the rows themselves never round-trip through the projection.
 */
function groupTurns(conversation: ConversationState, rendered: Message[]): Turn[] {
  const turns: Turn[] = [];
  let index = 0;
  let latestUserSentAt: string | null = null;

  for (const group of groupIntoTurns(conversation)) {
    const start = index;
    index += group.entries.length;
    const slice = rendered.slice(start, index);

    if (group.role === "user") {
      // One row per user turn: the engine emits exactly one echo per turn, so
      // a run of user entries can only be one message.
      slice.forEach((message, offset) => {
        latestUserSentAt = message.sent_at ?? null;
        turns.push({ type: "user", message, messageIndex: start + offset });
      });
      continue;
    }

    turns.push({
      type: "assistant",
      messages: slice,
      firstMessageIndex: start,
      isLatest: group.isLatest,
      // The clock starts when the user asked, which is the turn before this.
      startedAt: latestUserSentAt,
    });
  }

  return turns;
}

const USER_PADDING_CLASS = "pb-8";
const TIGHT_PADDING_CLASS = "pb-1";

/**
 * Spacing between turns, as PADDING rather than margin.
 *
 * Virtual items are absolutely positioned, so margins do not affect layout.
 * Padding is included in getBoundingClientRect().height, which is what the
 * virtualizer's measureElement reads — and it has to be pre-computed per index
 * because the virtualizer skips off-screen items, so a turn cannot ask its DOM
 * neighbours who they are.
 */
function turnSpacingClasses(
  turn: ChatTimelineItem,
  prevTurn: ChatTimelineItem | null,
  nextTurn: ChatTimelineItem | null,
  isFirst: boolean
): string {
  const isUser = turn.type === "user";

  const topClass = (() => {
    // Compaction divider: breathing room on both sides, it IS the seam.
    if (turn.type === "compaction") return isFirst ? "pt-6" : "pt-4";

    if (isUser) {
      if (isFirst) return "pt-8";
      if (prevTurn?.type === "user") return "pt-0";
      if (prevTurn?.type === "compaction") return "pt-4";
      return "pt-8";
    }

    // Assistant turn
    if (isFirst) return "pt-1";
    if (prevTurn?.type === "compaction") return "pt-2";
    return "pt-0";
  })();

  const bottomClass = (() => {
    if (turn.type === "compaction") return "pb-0";
    if (isUser) return USER_PADDING_CLASS;
    // Assistant turn
    if (nextTurn?.type === "user") return "pb-0";
    if (nextTurn) return TIGHT_PADDING_CLASS;
    return "pb-0";
  })();

  return cn(topClass, bottomClass);
}

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
