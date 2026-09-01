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
// The reducer is the one value the renderer takes from the protocol BARREL,
// because `reduce.ts` imports zod and the package ships no zod-free subpath
// for it. Everything else here comes from a narrow subpath. See the note in
// shared/protocol-types.ts.
// eslint-disable-next-line no-restricted-imports -- reduce has no zod-free subpath
import { emptyConversation, reduceConversationWithChanges } from "@zvada/agent-server/protocol";
import { createSeqCursor, type SeqCursor } from "@zvada/agent-server/protocol/seq-cursor";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Message } from "@shared/types/session";
import {
  cancelledTurnRow,
  compactionRow,
  findConversationCompaction,
  findConversationMessage,
  turnAccountingRow,
} from "@shared/conversation-rows";
import {
  isUnknownEvent,
  type AnyLifecycleEvent,
  type ConversationChange,
  type ConversationMessage,
  type ConversationState,
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

/**
 * Reload one session's message page — the fold's escape hatch, for the changes
 * it cannot project itself (a compaction row, a seq hole, a replaced log).
 *
 * It reaches a BACKGROUND session, and that is the whole requirement: a
 * compaction usually lands on a session whose panel is not mounted, its page
 * has no observer, and `staleTime: Infinity` means re-opening the tab will
 * never refetch on its own. `refetchQueries` covers it — called directly, its
 * `type` filter defaults to "all", not to "active" (only `invalidateQueries`
 * injects "active", as its `refetchType`), so an observer-less page that has
 * fetched at least once is refetched here and is already fresh when the tab
 * comes back. It lives beside the fold rather than inline in the hook so that
 * property is pinned by a test instead of by this paragraph.
 */
export function refetchMessages(qc: QueryClient, sessionId: string): Promise<void> {
  return qc.refetchQueries({ queryKey: messagesKey(sessionId), exact: true });
}

/**
 * Drop folds for sessions the message cache no longer holds a page for.
 *
 * `routeEnvelope` refuses to fold a session with no cached page, so such a fold
 * is unreachable state: the page was garbage-collected out from under it and
 * nothing will project it again. Pruning ties the fold set to the cache it
 * writes into, which is what bounds folds that outlive a panel — see the note
 * in `useAgentEvents`.
 */
export function pruneFolds(qc: QueryClient, folds: Map<string, SessionFold>): void {
  for (const sessionId of [...folds.keys()]) {
    if (!qc.getQueryData<PaginatedMessages>(messagesKey(sessionId))) folds.delete(sessionId);
  }
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

/**
 * Fold one already-decoded event, for a lane that has no wire `seq`.
 *
 * The direct-agnt lane's frames carry no seq, so it can't (and needn't) use
 * `routeEnvelope`'s gap/reset/duplicate cursor arithmetic — a socket reconnect
 * heals by re-folding the snapshot (upsert-by-id, idempotent), not by a cursor
 * reset. This is the seq-free entry point it folds through. `live` derives the
 * same way `routeEnvelope` computes it, so delta batching still applies to the
 * mounted session.
 */
export function foldEvent(
  ctx: AgentStreamContext,
  sessionId: string,
  event: AnyLifecycleEvent
): void {
  applyEvent(ctx, sessionId, event, sessionId === ctx.activeSessionId);
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
        // Project the folded entity into that list so the direct lane (no
        // backend to page from) shows the "context compacted" divider; the Mac
        // lane ALSO refetches, and the two converge on the same COALESCE-merged
        // row (the projection is idempotent against the refetch's authoritative copy).
        writeCompaction(ctx.queryClient, sessionId, fold.state, change.compactionId);
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
  const message = findConversationMessage(state, messageId);
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
 * message — the same row the backend writes, from the same `turnAccountingRow`
 * in `shared/conversation-rows.ts`. A turn cancelled before the model said
 * anything has no such row, so this mints the SAME marker the backend does,
 * under the same derived id, and the "Response stopped" divider appears live.
 *
 * The four fields are applied the way the backend's SQL applies them, which is
 * a deliberate ALIGNMENT rather than the cache's previous behaviour: null
 * tokens/cost/cancelled_at leave the cached value alone (the SQL's
 * `COALESCE(?, col)`) and `turn_stop_reason` is written whatever it is (the
 * SQL's plain `= ?`). The cache used to skip tokens/cost on a minted marker
 * and substitute "cancelled" for a missing stop reason; SQLite is the durable
 * truth these rows deduplicate against, so the cache converges to it.
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
  const accounting = turnAccountingRow(turn);

  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;
    const index = old.messages.findLastIndex(
      (m) => m.turn_id === turnId && m.role === "assistant" && !m.parent_tool_call_id
    );
    if (index === -1) {
      return turn.stopReason === "cancelled"
        ? { ...old, messages: [...old.messages, cancelledTurnRow(sessionId, turn)] }
        : old;
    }

    const messages = [...old.messages];
    messages[index] = {
      ...messages[index],
      turn_stop_reason: accounting.turn_stop_reason,
      ...(accounting.tokens !== null && { tokens: accounting.tokens }),
      ...(accounting.cost !== null && { cost: accounting.cost }),
      ...(accounting.cancelled_at !== null && { cancelled_at: accounting.cancelled_at }),
    };
    return { ...old, messages };
  });
}

// ---- Compactions ----

/**
 * Mirror the folded compaction entity into the cache's `compactions` list — the
 * table-of-its-own the "context compacted" divider reads from. This is the
 * compaction twin of `writeTurnAccounting`: it applies the SAME upsert
 * `persistCompaction`'s SQL applies, so the row the direct lane writes and the
 * row the backend writes converge field-for-field.
 *
 * `status` REPLACES (the turn's latest word wins); the optional
 * trigger/token/summary fields COALESCE — `compactionRow` omits whatever the
 * engine hasn't sent, so the spread keeps a prior event's value rather than
 * nulling it; and `created_at` stays ANCHORED to the first event (the SQL never
 * moves it on conflict), so a replayed snapshot doesn't shuffle the divider.
 */
function writeCompaction(
  qc: QueryClient,
  sessionId: string,
  state: ConversationState,
  compactionId: string
): void {
  const entity = findConversationCompaction(state, compactionId);
  if (!entity) return;
  const row = compactionRow(sessionId, entity);

  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) {
      // Only reachable live before the page has loaded (a background session
      // with no cached page never gets here — see routeEnvelope's guard). The
      // real page, once it resolves, supersedes this seed.
      return { messages: [], compactions: [row], has_older: false, has_newer: false };
    }
    const index = old.compactions.findIndex((c) => c.compaction_id === row.compaction_id);
    if (index === -1) return { ...old, compactions: [...old.compactions, row] };

    const previous = old.compactions[index];
    const compactions = [...old.compactions];
    compactions[index] = { ...previous, ...row, created_at: previous.created_at };
    return { ...old, compactions };
  });
}

// ---- Session-detail projection (direct lane) ----

/**
 * Patch the cached `sessions.detail` row for a DIRECT session.
 *
 * The Mac lane's detail row is WS-push-fresh (q:snapshot on every status
 * change), but web-direct has no push and the query is `staleTime: Infinity` —
 * so without this, a direct session's status stays wherever discovery left it:
 * the working indicator and Stop button never appear, or stick forever. The
 * direct frame handler projects the turn lifecycle (and snapshot facts like
 * message count) through here instead. Merge-patch by design: only the fields
 * the caller knows move; an uncached row is left absent (discovery owns
 * creation).
 */
export function patchSessionDetail(
  qc: QueryClient,
  sessionId: string,
  patch: Partial<import("@shared/types/session").Session>
): void {
  qc.setQueryData<import("@shared/types/session").Session>(
    queryKeys.sessions.detail(sessionId),
    (old) => (old ? { ...old, ...patch } : old)
  );
}

// ---- Transcript order (snapshot backfill) ----

/**
 * Reorder the cached page so `orderedIds` lead, in that order, and every row the
 * caller doesn't name trails in place. Used once, after a snapshot backfill:
 * `writeMessage` APPENDS a row it hasn't seen, so an optimistic prompt sent
 * before the snapshot lands ends up ahead of the reconstructed history — this
 * repairs that. The snapshot IS the full transcript, so it also stamps
 * `has_older: false`.
 *
 * Lives here with the other `messages`-cache writers (writeMessage,
 * writeTurnAccounting, writeCompaction) so this key has exactly one writer
 * module — the direct-lane handler calls it, but doesn't reach into the cache.
 */
export function commitTranscriptOrder(
  qc: QueryClient,
  sessionId: string,
  orderedIds: string[]
): void {
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;
    const known = old.messages
      .filter((m) => rank.has(m.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const unknown = old.messages.filter((m) => !rank.has(m.id));
    return { ...old, messages: [...known, ...unknown], has_older: false };
  });
}
