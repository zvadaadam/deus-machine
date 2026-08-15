/**
 * The fold: one @zvada/agent-server lifecycle envelope → the `messages` cache.
 *
 *   agent:event ──┐
 *                 ├─→ setQueryData() → TanStack cache → React renders
 *   DB snapshot ──┘
 *
 * This is deus's OWN fold, not the engine's `reduceConversation`. The engine's
 * reducer produces a `ConversationState`; the cache holds a paginated
 * `Message[]` with SQLite row shapes (seq, turn_id, tokens, cancelled_at), so
 * projecting one onto the other costs more than folding directly. Swapping to
 * `reduceConversation` + a projection is tracked as a follow-up — until then no
 * comment in this repo may claim the reducer is in use.
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
 *                DURABLE events (message.started / message.part / turn.ended):
 *                the `messages` subscription is delta-only with its cursor
 *                jumped to MAX(seq), so an UPDATE-shaped change (tokens, cost,
 *                turn_stop_reason, cancelled_at) has no other way in. Deltas
 *                are skipped — nobody is looking, and the snapshot restates
 *                them.
 */

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { cancelledTurnMessageId, type Message } from "@shared/types/session";
import {
  isUnknownLifecycleEvent,
  isUnknownPart,
  type AnyLifecycleEvent,
  type AnyMessagePartEvent,
  type AnyWireEventEnvelope,
  type MessageStartedEvent,
  type Part,
  type TurnEndedEvent,
  type UnknownPart,
} from "@shared/protocol-types";
import type { PaginatedMessages } from "../api/session.service";
import { isLocalMessage, isLocalPart } from "./optimisticMessage";

export type AnyPart = Part | UnknownPart;

// ---- Delta buffer ----

/** Text/reasoning deltas accumulated between two animation frames. */
export interface DeltaBuffer {
  pending: Map<string, string>;
}

export function createDeltaBuffer(): DeltaBuffer {
  return { pending: new Map() };
}

// ---- Stream context ----

export interface AgentStreamContext {
  queryClient: QueryClient;
  /** The session whose panel is mounted — the only one that streams deltas. */
  activeSessionId: string;
  buffer: DeltaBuffer;
  /** Per-session wire cursor, for gap and reset detection. */
  cursors: Map<string, number>;
  /** Ask for a delta flush on the next frame. */
  scheduleFlush: () => void;
  /** Ask for a debounced refetch of one session's message page. */
  requestRefetch: (sessionId: string) => void;
}

export function messagesKey(sessionId: string) {
  return queryKeys.sessions.messages(sessionId);
}

// ---- Sequence cursor ----

/**
 * What one envelope's `seq` says about the stream.
 *
 *   ok        — the expected next envelope (or the first one seen).
 *   duplicate — already folded; re-applying would double-count a delta.
 *   gap       — envelopes were missed (reconnect, backend restart).
 *   reset     — `seq` went BACKWARDS: the session's log restarted (the
 *               agent-server process was replaced and numbers from 1 again).
 *               Clamping with Math.max here would freeze the cursor above
 *               every future envelope and disable gap detection for the rest
 *               of the session's life, silently.
 *
 * `gap` and `reset` both move the cursor to the envelope actually received —
 * detection stays live either way — and both ask for a refetch, because
 * snapshots are durable but the deltas in the hole are not.
 */
export type SeqVerdict = "ok" | "duplicate" | "gap" | "reset";

export function advanceCursor(
  cursors: Map<string, number>,
  sessionId: string,
  seq: number
): SeqVerdict {
  const last = cursors.get(sessionId);
  if (last === undefined) {
    cursors.set(sessionId, seq);
    return "ok";
  }
  if (seq === last) return "duplicate";

  cursors.set(sessionId, seq);
  if (seq < last) return "reset";
  if (seq > last + 1) return "gap";
  return "ok";
}

// ---- Routing ----

/** Fold one envelope. The single entry point the hook calls per WS frame. */
export function routeEnvelope(ctx: AgentStreamContext, envelope: AnyWireEventEnvelope): void {
  const sessionId = envelope?.sessionId;
  if (!sessionId) return;

  const verdict = advanceCursor(ctx.cursors, sessionId, envelope.seq);
  if (verdict === "duplicate") return;
  if (verdict !== "ok") ctx.requestRefetch(sessionId);

  if (sessionId === ctx.activeSessionId) {
    applyLiveEvent(ctx, envelope.event);
    return;
  }
  applyBackgroundEvent(ctx.queryClient, sessionId, envelope.event);
}

/** The mounted session: the whole stream, deltas included. */
export function applyLiveEvent(ctx: AgentStreamContext, event: AnyLifecycleEvent): void {
  // Law 6: an unknown event type is preserved in the stream but carries no
  // cache state by definition — there is nothing here to fold.
  if (isUnknownLifecycleEvent(event)) return;
  const { queryClient: qc, activeSessionId: sessionId } = ctx;
  switch (event.type) {
    case "message.started":
      upsertMessageRow(qc, sessionId, event, { seed: true });
      return;
    case "message.part":
      // The snapshot's content is authoritative — drop anything buffered for it.
      ctx.buffer.pending.delete(event.part.id);
      upsertPart(qc, sessionId, event);
      return;
    case "message.part.delta":
      if (event.delta.type === "text" || event.delta.type === "reasoning") {
        const partId = event.partId;
        ctx.buffer.pending.set(partId, (ctx.buffer.pending.get(partId) ?? "") + event.delta.text);
        ctx.scheduleFlush();
      }
      return;
    case "turn.ended":
      patchTurnAccounting(qc, sessionId, event);
      return;
    case "session.compaction":
      // The marker lives in its own table, alongside the message page.
      ctx.requestRefetch(sessionId);
      return;
    default:
      // message.ended is a bracket marker; session.*/permission.*/error/raw
      // carry no message-cache state (session status arrives via q:delta).
      return;
  }
}

/**
 * A session the user is not looking at. Durable events only, and never for a
 * session that has no cached page — seeding one would invent a `has_older:
 * false` page for a transcript nobody has loaded.
 */
export function applyBackgroundEvent(
  qc: QueryClient,
  sessionId: string,
  event: AnyLifecycleEvent
): void {
  // Law 6: an unknown event type is preserved in the stream but carries no
  // cache state by definition — there is nothing here to fold.
  if (isUnknownLifecycleEvent(event)) return;
  if (!qc.getQueryData<PaginatedMessages>(messagesKey(sessionId))) return;
  switch (event.type) {
    case "message.started":
      upsertMessageRow(qc, sessionId, event, { seed: false });
      return;
    case "message.part":
      upsertPart(qc, sessionId, event);
      return;
    case "turn.ended":
      patchTurnAccounting(qc, sessionId, event);
      return;
    default:
      return;
  }
}

// ---- Message rows ----

/**
 * Open (or reconcile) the row for a message. This covers the USER echo: the
 * send command writes no message row, the engine echoes the prompt back and
 * that echo is the persistence source of truth. The composer's optimistic
 * bubble carries the same `turn_id`, so it is replaced in place — never left
 * beside its own echo as a second bubble.
 */
function upsertMessageRow(
  qc: QueryClient,
  sessionId: string,
  event: MessageStartedEvent,
  opts: { seed: boolean }
): void {
  const row: Message = {
    id: event.messageId,
    session_id: sessionId,
    seq: 0,
    role: event.role,
    content: null,
    turn_id: event.turnId,
    model: event.model ?? null,
    sent_at: new Date(event.timestamp).toISOString(),
    parent_tool_call_id: event.parentToolCallId ?? null,
    parts: [],
  };

  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) {
      return opts.seed
        ? { messages: [row], compactions: [], has_older: false, has_newer: false }
        : old;
    }
    const messages = reconcileEcho(old.messages, row);
    return messages === old.messages ? old : { ...old, messages };
  });
}

/**
 * Merge an engine message row into the page, absorbing the composer's local
 * bubble for the same turn.
 *
 * Both orderings have to converge, because the backend invalidates (→ q:delta
 * with the real row) BEFORE it pushes the envelope:
 *   delta first  → the real row is already here; drop the local twin.
 *   event first  → swap the local twin for the real row, keeping its rendered
 *                  parts so the bubble does not blink empty until the echo's
 *                  own parts arrive.
 */
export function reconcileEcho(messages: Message[], row: Message): Message[] {
  const existing = messages.findIndex((m) => m.id === row.id);
  const local =
    row.role === "user" && row.turn_id
      ? messages.findIndex((m) => isLocalMessage(m) && m.turn_id === row.turn_id)
      : -1;

  if (existing !== -1) {
    if (local === -1) return messages;
    const next = [...messages];
    next.splice(local, 1);
    return next;
  }

  if (local !== -1) {
    const next = [...messages];
    const previous = next[local];
    next[local] = { ...row, seq: previous.seq, parts: previous.parts };
    return next;
  }

  return [...messages, row];
}

// ---- Parts ----

/** Replace one message's parts. No-op when the message isn't cached yet. */
function mutateParts(
  qc: QueryClient,
  sessionId: string,
  messageId: string,
  updater: (parts: AnyPart[]) => AnyPart[]
): void {
  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;
    const index = old.messages.findIndex((m) => m.id === messageId);
    if (index === -1) return old;

    const message = old.messages[index];
    const parts = updater(message.parts ?? []);
    if (parts === message.parts) return old;

    const messages = [...old.messages];
    messages[index] = { ...message, parts };
    return { ...old, messages };
  });
}

/** Snapshots are authoritative: upsert by part id, replacing whatever is there. */
function upsertPart(qc: QueryClient, sessionId: string, event: AnyMessagePartEvent): void {
  mutateParts(qc, sessionId, event.messageId, (parts) => {
    // The first authoritative part evicts the composer's placeholders: they
    // rendered the same text under a local id and would otherwise double it.
    const base = parts.some(isLocalPart) ? parts.filter((p) => !isLocalPart(p)) : parts;
    const index = base.findIndex((p) => p.id === event.part.id);
    if (index === -1) return [...base, event.part];
    const next = [...base];
    next[index] = event.part;
    return next;
  });
}

/** Apply the buffered deltas. Called from the hook's animation frame. */
export function flushDeltas(qc: QueryClient, sessionId: string, buffer: DeltaBuffer): void {
  if (buffer.pending.size === 0) return;

  const deltas = new Map(buffer.pending);
  buffer.pending.clear();

  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;

    let mutated = false;
    const messages = old.messages.map((message) => {
      if (!message.parts) return message;

      let partsChanged = false;
      const parts = message.parts.map((part): AnyPart => {
        const delta = deltas.get(part.id);
        if (!delta) return part;
        if (isUnknownPart(part)) return part;
        if (part.type !== "text" && part.type !== "reasoning") return part;
        partsChanged = true;
        return { ...part, text: part.text + delta };
      });

      if (!partsChanged) return message;
      mutated = true;
      return { ...message, parts };
    });

    return mutated ? { ...old, messages } : old;
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
function patchTurnAccounting(qc: QueryClient, sessionId: string, event: TurnEndedEvent): void {
  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;
    const index = old.messages.findLastIndex(
      (m) => m.turn_id === event.turnId && m.role === "assistant" && !m.parent_tool_call_id
    );
    if (index === -1) {
      return event.stopReason === "cancelled"
        ? { ...old, messages: [...old.messages, cancelledMarker(sessionId, event)] }
        : old;
    }

    const messages = [...old.messages];
    messages[index] = {
      ...messages[index],
      turn_stop_reason: event.stopReason,
      ...(event.tokens ? { tokens: JSON.stringify(event.tokens) } : {}),
      ...(event.cost !== undefined ? { cost: event.cost } : {}),
      ...(event.stopReason === "cancelled"
        ? { cancelled_at: new Date(event.timestamp).toISOString() }
        : {}),
    };
    return { ...old, messages };
  });
}

/** The zero-part assistant row that says "this turn was interrupted". */
function cancelledMarker(sessionId: string, event: TurnEndedEvent): Message {
  const at = new Date(event.timestamp).toISOString();
  return {
    id: cancelledTurnMessageId(event.turnId),
    session_id: sessionId,
    seq: 0,
    role: "assistant",
    content: null,
    turn_id: event.turnId,
    model: null,
    sent_at: at,
    cancelled_at: at,
    turn_stop_reason: "cancelled",
    parts: [],
  };
}
