/**
 * The fold: one @zvada/agent-server lifecycle envelope → the `messages` cache.
 *
 *   agent:event ──┐
 *                 ├─→ reduceConversationWithChanges ─→ setQueryData() → React
 *   DB snapshot ──┘
 *
 * The fold is the ENGINE's, not deus's. What lives here is only the
 * PROJECTION: a `ConversationState` per session, and the SQLite-row writes its
 * `changes` imply. Every consumption rule the reducer encodes — upsert by part
 * id, snapshots beating deltas, a tool part landing back on the message that
 * already ended, cancellation closure, replay convergence — arrives with it and
 * stops being deus's to get right.
 *
 * `changes` is what makes the projection possible without diffing: the reducer
 * reports each mutation it performs, addressed by the ids the wire carries. A
 * redelivered identity or bracket event (message.started, turn.*, message.ended)
 * reports nothing at all; a redelivered part SNAPSHOT is reported and re-written,
 * because the reducer upserts snapshots rather than comparing them — which is
 * exactly what makes it safe to write it again.
 *
 * It lives outside the hook so the fold is testable without React, a DOM or a
 * socket: every entry point takes a `QueryClient` and returns nothing.
 *
 * Two grades of delivery:
 *
 *   live       — the session whose panel is mounted. Everything, deltas
 *                included, and the page may be seeded before the first fetch
 *                resolves.
 *   background — any other session that already has a cached page. Only the
 *                DURABLE events: the `messages` subscription is delta-only with
 *                its cursor jumped to MAX(seq), so an UPDATE-shaped change
 *                (tokens, cost, turn_stop_reason, cancelled_at) has no other
 *                way in. Deltas are skipped — nobody is looking, and the next
 *                snapshot restates them.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  createSeqCursor,
  emptyConversation,
  reduceConversationWithChanges,
  type SeqCursor,
} from "@zvada/agent-server/protocol";
import { queryKeys } from "@/shared/api/queryKeys";
import { cancelledTurnMessageId, type Message } from "@shared/types/session";
import {
  isUnknownEvent,
  type AnyLifecycleEvent,
  type ConversationChange,
  type ConversationMessage,
  type ConversationState,
  type ConversationTurn,
  type DecodedWireEventEnvelope,
} from "@shared/protocol-types";
import type { PaginatedMessages } from "../api/session.service";

// ---- Per-session fold ----

/**
 * One session's folded conversation, plus the messages whose parts moved since
 * the last animation frame.
 *
 * The dirty set is all that is left of deus's delta bookkeeping. The reducer
 * already applies text/reasoning deltas into their part (and accumulates
 * streamed tool input in `state.toolInputJson`), so there is nothing to
 * accumulate here — only a reason to BATCH: a delta arrives per token, and one
 * `setQueryData` per token is one React render per token. The frame flush
 * copies out the parts the state already holds.
 */
export interface SessionFold {
  state: ConversationState;
  dirtyMessages: Set<string>;
}

export function createSessionFold(): SessionFold {
  return { state: emptyConversation(), dirtyMessages: new Set() };
}

/** The per-session `seq` bookkeeping — the engine's own, not a fourth copy. */
export function createStreamCursor(): SeqCursor {
  return createSeqCursor();
}

// ---- Stream context ----

export interface AgentStreamContext {
  queryClient: QueryClient;
  /** The session whose panel is mounted — the only one that streams deltas. */
  activeSessionId: string;
  /** Folded conversation per session; the source of every cache write. */
  folds: Map<string, SessionFold>;
  /** Per-session wire cursor, for gap and reset detection. */
  cursor: SeqCursor;
  /** Ask for a delta flush on the next frame. */
  scheduleFlush: () => void;
  /** Ask for a debounced refetch of one session's message page. */
  requestRefetch: (sessionId: string) => void;
}

export function messagesKey(sessionId: string) {
  return queryKeys.sessions.messages(sessionId);
}

// ---- Routing ----

/** Fold one envelope. The single entry point the hook calls per WS frame. */
export function routeEnvelope(ctx: AgentStreamContext, envelope: DecodedWireEventEnvelope): void {
  const sessionId = envelope?.sessionId;
  if (!sessionId) return;

  // Deus joins a live stream mid-flight — the page comes from SQLite, the
  // socket from wherever the turn already is — so the FIRST envelope seen for
  // a session is never a hole. Seek to just before it and let the cursor's own
  // arithmetic run from there.
  if (ctx.cursor.last(sessionId) === 0) ctx.cursor.seek(sessionId, envelope.seq - 1);

  let verdict = ctx.cursor.advance(sessionId, envelope.seq);
  if (verdict === "duplicate" && envelope.seq !== ctx.cursor.last(sessionId)) {
    // Backwards beyond the last frame. The engine cursor only calls it a
    // reset when a fresh log is seen FROM seq 1; here the log was replaced
    // and this client first sees it mid-stream (its own reconnect overlapped
    // the restart, or a restarted backend re-forwards from a healed log).
    // A real redelivery is only ever the immediately-last frame — anything
    // further back is a dead watermark, and honoring it would silently drop
    // every envelope until the new counter catches up.
    ctx.cursor.seek(sessionId, envelope.seq);
    verdict = "reset";
  }

  switch (verdict) {
    case "duplicate":
      // Already folded. (The reducer would report no changes for it anyway —
      // this only saves the work.)
      return;
    case "reset":
      // The agent-server was replaced and its session log starts at 1 again.
      // Everything folded belongs to the dead log: drop it, and refetch,
      // because the new log will not restate what the old one already wrote.
      ctx.folds.delete(sessionId);
      ctx.requestRefetch(sessionId);
      break;
    case "gap":
      // Envelopes were missed. Nothing in the browser can replay them, so the
      // hole is accepted as lost — leaving the cursor put (the engine client
      // does, because it CAN replay) would make every following envelope read
      // as another gap. Refetch: the snapshots in the hole are durable in
      // SQLite, the deltas are not.
      ctx.cursor.seek(sessionId, envelope.seq);
      ctx.requestRefetch(sessionId);
      break;
    case "deliver":
      break;
  }

  const live = sessionId === ctx.activeSessionId;
  // Never fold for a session nobody has opened: seeding a page from a
  // mid-stream fragment would invent a `has_older: false` transcript.
  if (!live && !ctx.queryClient.getQueryData<PaginatedMessages>(messagesKey(sessionId))) return;

  applyEvent(ctx, sessionId, envelope.event, live);
}

function foldFor(ctx: AgentStreamContext, sessionId: string): SessionFold {
  const existing = ctx.folds.get(sessionId);
  if (existing) return existing;
  const created = createSessionFold();
  ctx.folds.set(sessionId, created);
  return created;
}

function applyEvent(
  ctx: AgentStreamContext,
  sessionId: string,
  event: AnyLifecycleEvent,
  live: boolean
): void {
  const fold = foldFor(ctx, sessionId);
  const { state, changes } = reduceConversationWithChanges(fold.state, event);
  fold.state = state;
  if (changes.length === 0) return;

  // A delta's part write is the hot path: batched to one cache write per frame
  // for the mounted session, and skipped entirely for every other one.
  if (!isUnknownEvent(event) && event.type === "message.part.delta") {
    if (!live) return;
    for (const change of changes) {
      if (change.kind === "part-upserted") fold.dirtyMessages.add(change.messageId);
    }
    if (fold.dirtyMessages.size > 0) ctx.scheduleFlush();
    return;
  }

  applyChanges(ctx, sessionId, fold, changes, live);
}

/** Project one event's changes onto the cached page. */
function applyChanges(
  ctx: AgentStreamContext,
  sessionId: string,
  fold: SessionFold,
  changes: ConversationChange[],
  live: boolean
): void {
  for (const change of changes) {
    switch (change.kind) {
      case "message-upserted":
        // Causally ordered before the part that forced the shell, so a row
        // always exists by the time its parts land.
        writeMessage(ctx.queryClient, sessionId, fold.state, change.messageId, { seed: live });
        break;
      case "part-upserted":
        // The folded message carries its parts, so the row write IS the part
        // write — no splicing a part into a copy of an array the state has.
        writeMessage(ctx.queryClient, sessionId, fold.state, change.messageId, { seed: false });
        // An authoritative snapshot supersedes whatever the frame was about to
        // flush for this message.
        fold.dirtyMessages.delete(change.messageId);
        break;
      case "turn-updated":
        writeTurnAccounting(ctx.queryClient, sessionId, fold.state, change.turnId);
        break;
      case "compaction-upserted":
        // Compactions live in a table of their own beside the message page.
        ctx.requestRefetch(sessionId);
        break;
      default:
        // message-ended (a bracket marker), delta-buffered (tool input, read
        // from state.toolInputJson), permission-updated, usage-updated,
        // session-meta-updated, session-ended, unknown-event-recorded — none
        // of them is a `messages` row.
        break;
    }
  }
}

/** Apply the frame's dirty messages. Called from the hook's animation frame. */
export function flushDeltas(qc: QueryClient, sessionId: string, fold: SessionFold): void {
  if (fold.dirtyMessages.size === 0) return;
  const dirty = [...fold.dirtyMessages];
  fold.dirtyMessages.clear();
  for (const messageId of dirty) {
    writeMessage(qc, sessionId, fold.state, messageId, { seed: false });
  }
}

// ---- Message rows ----

/**
 * The engine's folded message → the SQLite row shape the cache holds.
 *
 * `model` and `parentToolCallId` are OMITTED when the fold does not know them
 * rather than written as null: a message the fold only ever saw as a shell
 * (a part outran its `message.started`, or deus attached mid-message) knows
 * neither, and writing null would erase what the DB snapshot already had.
 */
/**
 * Upsert the fold's parts into the cached row's, by part id — the same
 * append-only-by-id rule the pre-fold cache used. `next` wins for a part both
 * sides know (the fold is fresher); parts only the cache knows survive.
 *
 * CONSIDERED AND REJECTED: seeding the fold from the DB page instead (the way
 * agnt seeds from `session.snapshot`), which would make the cache a pure
 * projection and delete this merge. agnt's snapshot arrives ON the event
 * channel, ordered ahead of the events by the server; deus's page is a
 * separate query RACING the WS stream, so seeding here needs an
 * envelope-buffering protocol around page arrival plus pagination re-seeding —
 * strictly more machinery than these ~20 self-healing lines, with new failure
 * modes in exactly the interleavings that bit this file before. Two genuinely
 * independent sources want a merge, not a fake ordering.
 */
function mergePartsById(previous: Message["parts"], next: Message["parts"]): Message["parts"] {
  if (!previous?.length) return next;
  if (!next?.length) return previous;
  const merged = [...previous];
  const indexById = new Map(merged.map((part, index) => [part.id, index]));
  for (const part of next) {
    const at = indexById.get(part.id);
    if (at === undefined) {
      indexById.set(part.id, merged.length);
      merged.push(part);
    } else {
      merged[at] = part;
    }
  }
  return merged;
}

function toMessageRow(sessionId: string, message: ConversationMessage): Message {
  return {
    id: message.messageId,
    session_id: sessionId,
    seq: 0,
    role: message.role,
    turn_id: message.turnId,
    sent_at: new Date(message.startedAt).toISOString(),
    ...(message.model !== undefined && { model: message.model }),
    ...(message.parentToolCallId !== undefined && {
      parent_tool_call_id: message.parentToolCallId,
    }),
    parts: message.parts,
  };
}

function findMessage(state: ConversationState, messageId: string): ConversationMessage | undefined {
  // From the end: the message being written is almost always the recent one.
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const entry = state.timeline[i];
    if (entry.kind === "message" && entry.messageId === messageId) return entry;
  }
  return undefined;
}

/**
 * Write one folded message into the cached page, upserting BY ID.
 *
 * That is also how the composer's optimistic bubble is absorbed: it is minted
 * with `echoMessageId(turnId)` and `createUserEchoParts`, so the engine's echo
 * for that turn IS the same row with the same part ids and the upsert lands on
 * it. No look-alike to find by turn id, no swap, and no window where the
 * prompt renders twice or loses its attachments in the swap.
 *
 * Columns SQLite owns and the stream knows nothing about survive the write:
 * `seq`, and the turn accounting stamped at `turn.ended`.
 */
function writeMessage(
  qc: QueryClient,
  sessionId: string,
  state: ConversationState,
  messageId: string,
  opts: { seed: boolean }
): void {
  const message = findMessage(state, messageId);
  if (!message) return;
  const row = toMessageRow(sessionId, message);

  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) {
      return opts.seed
        ? { messages: [row], compactions: [], has_older: false, has_newer: false }
        : old;
    }
    const index = old.messages.findIndex((m) => m.id === row.id);
    if (index === -1) return { ...old, messages: [...old.messages, row] };

    const previous = old.messages[index];
    const messages = [...old.messages];
    messages[index] = {
      ...previous,
      ...row,
      seq: previous.seq,
      // The optimistic bubble stamps `sent_at` at send time and the echo
      // re-stamps it at admission; keeping the first stops the turn-duration
      // clock jumping backwards when the echo lands.
      sent_at: previous.sent_at ?? row.sent_at,
      // BY ID, never wholesale: the fold may hold only a mid-stream FRAGMENT
      // of this message (attach mid-turn, tab switch resetting the fold, a
      // seq gap) while the cached page carries the full DB row — replacing
      // the array would erase every part the fold never saw. The reducer only
      // ever upserts parts, so merging is always safe, and an empty fold list
      // is always "none known yet", never "they were removed".
      parts: mergePartsById(previous.parts, row.parts),
    };
    return { ...old, messages };
  });
}

// ---- Turn accounting ----

/**
 * Turn accounting, mirrored into the cache so the footer updates without
 * waiting for a refetch. It lands on the turn's last top-level assistant
 * message — the same row the backend writes.
 *
 * A turn cancelled before the model said anything has no such row; the backend
 * mints a marker row for it, and this mirrors that row under the same
 * deterministic id so the "Response stopped" divider appears live too.
 */
function writeTurnAccounting(
  qc: QueryClient,
  sessionId: string,
  state: ConversationState,
  turnId: string
): void {
  const turn = state.turns.find((t) => t.turnId === turnId);
  // `turn-updated` also reports a turn OPENING, and a non-terminal error
  // attributed to a turn — neither has accounting to mirror yet.
  if (!turn || turn.status !== "ended") return;
  const cancelled = turn.stopReason === "cancelled";
  const endedAt = new Date(turn.endedAt ?? Date.now()).toISOString();

  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;
    const index = old.messages.findLastIndex(
      (m) => m.turn_id === turnId && m.role === "assistant" && !m.parent_tool_call_id
    );
    if (index === -1) {
      return cancelled
        ? { ...old, messages: [...old.messages, cancelledMarker(sessionId, turnId, endedAt, turn)] }
        : old;
    }

    const messages = [...old.messages];
    messages[index] = {
      ...messages[index],
      turn_stop_reason: turn.stopReason,
      ...(turn.tokens ? { tokens: JSON.stringify(turn.tokens) } : {}),
      ...(turn.cost !== undefined ? { cost: turn.cost } : {}),
      ...(cancelled ? { cancelled_at: endedAt } : {}),
    };
    return { ...old, messages };
  });
}

/** The zero-part assistant row that says "this turn was interrupted". */
function cancelledMarker(
  sessionId: string,
  turnId: string,
  at: string,
  turn: ConversationTurn
): Message {
  return {
    id: cancelledTurnMessageId(turnId),
    session_id: sessionId,
    seq: 0,
    role: "assistant",
    turn_id: turnId,
    model: null,
    sent_at: at,
    cancelled_at: at,
    turn_stop_reason: turn.stopReason ?? "cancelled",
    parts: [],
  };
}
