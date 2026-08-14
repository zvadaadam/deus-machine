/**
 * useAgentEvents — the canonical agent stream, folded into the message cache.
 *
 * The backend forwards every @zvada/agent-server lifecycle envelope verbatim
 * as ONE q:event (`agent:event`). This hook folds that stream into the
 * TanStack `messages` cache, so the live view and a reload converge on the
 * same rows:
 *
 *   agent:event ──┐
 *                 ├─→ setQueryData() → TanStack cache → React renders
 *   DB snapshot ──┘
 *
 * The envelope carries a per-session monotonic `seq`, so ordering and gap
 * detection are free: a gap means we missed events (reconnect, backend
 * restart) and the snapshot is refetched instead of blanket-invalidated.
 *
 * Parts are stored as the engine's `Part` objects — no dialect, no JSON
 * serialization. A delta flush is just `part.text += delta`.
 */

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Message } from "@shared/types";
import type {
  LifecycleEvent,
  MessageStartedEvent,
  MessagePartEvent,
  Part,
  TurnEndedEvent,
  UnknownPart,
  WireEventEnvelope,
} from "@shared/protocol-types";
import type { PaginatedMessages } from "../api/session.service";

type AnyPart = Part | UnknownPart;

// ---- Delta buffer ----

interface DeltaBuffer {
  pending: Map<string, string>;
  raf: number | null;
}

/** Per-session stream cursor for gap detection. */
interface SeqCursor {
  last: number;
}

// ---- Cache mutation ----

function messagesKey(sessionId: string) {
  return queryKeys.sessions.messages(sessionId);
}

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

// ---- Event handlers ----

/**
 * Open the row for a message. This covers the USER echo too: the send command
 * no longer writes the user's message — the engine echoes it back and that
 * echo is the persistence source of truth. An optimistic bubble seeded by the
 * composer under the same `turn_id` is reconciled here rather than duplicated.
 */
function onMessageStarted(qc: QueryClient, sessionId: string, event: MessageStartedEvent): void {
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
    if (!old) return { messages: [row], compactions: [], has_older: false, has_newer: false };
    if (old.messages.some((m) => m.id === row.id)) return old;

    // The composer's optimistic user bubble carries the same turn but a local
    // id — replace it in place so the message never blinks or doubles.
    if (event.role === "user") {
      const optimistic = old.messages.findIndex(
        (m) => m.role === "user" && m.turn_id === event.turnId && m.id !== row.id
      );
      if (optimistic !== -1) {
        const messages = [...old.messages];
        const previous = messages[optimistic];
        messages[optimistic] = { ...row, seq: previous.seq, content: previous.content };
        return { ...old, messages };
      }
    }

    return { ...old, messages: [...old.messages, row] };
  });
}

/** Snapshots are authoritative: upsert by part id, replacing whatever is there. */
function onMessagePart(qc: QueryClient, sessionId: string, event: MessagePartEvent): void {
  mutateParts(qc, sessionId, event.messageId, (parts) => {
    const index = parts.findIndex((p) => p.id === event.part.id);
    if (index === -1) return [...parts, event.part];
    const next = [...parts];
    next[index] = event.part;
    return next;
  });
}

/**
 * Turn accounting, mirrored into the cache so the footer updates without
 * waiting for a refetch. It lands on the turn's last top-level assistant
 * message — the same row the backend writes.
 */
function onTurnEnded(qc: QueryClient, sessionId: string, event: TurnEndedEvent): void {
  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), (old) => {
    if (!old) return old;
    const index = old.messages.findLastIndex(
      (m) => m.turn_id === event.turnId && m.role === "assistant" && !m.parent_tool_call_id
    );
    if (index === -1) return old;

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

function onPartDelta(
  qc: QueryClient,
  sessionId: string,
  buffer: DeltaBuffer,
  partId: string,
  text: string
): void {
  buffer.pending.set(partId, (buffer.pending.get(partId) ?? "") + text);
  if (buffer.raf === null) {
    buffer.raf = requestAnimationFrame(() => flushDeltas(qc, sessionId, buffer));
  }
}

function flushDeltas(qc: QueryClient, sessionId: string, buffer: DeltaBuffer): void {
  buffer.raf = null;
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
        if ("raw" in part) return part;
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

// ---- Hook ----

export function useAgentEvents(sessionId: string | null): void {
  const queryClient = useQueryClient();
  const deltaRef = useRef<DeltaBuffer>({ pending: new Map(), raf: null });
  const cursorRef = useRef<SeqCursor>({ last: 0 });

  // Reset on session change
  useEffect(() => {
    deltaRef.current.pending.clear();
    if (deltaRef.current.raf !== null) {
      cancelAnimationFrame(deltaRef.current.raf);
      deltaRef.current.raf = null;
    }
    cursorRef.current.last = 0;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    const unsub = onEvent((name: string, raw: unknown) => {
      if (name !== "agent:event") return;
      const envelope = raw as WireEventEnvelope;
      if (envelope?.sessionId !== sessionId) return;

      // A jump in `seq` means we missed events entirely (reconnect, backend
      // restart). Deltas are non-durable but snapshots are not — refetch this
      // session's messages rather than trusting a half-built cache.
      const cursor = cursorRef.current;
      if (cursor.last !== 0 && envelope.seq > cursor.last + 1) {
        void queryClient.refetchQueries({ queryKey: messagesKey(sessionId), exact: true });
      }
      cursor.last = Math.max(cursor.last, envelope.seq);

      applyEvent(queryClient, sessionId, deltaRef.current, envelope.event);
    });

    return () => {
      unsub();
      if (deltaRef.current.raf !== null) {
        cancelAnimationFrame(deltaRef.current.raf);
        deltaRef.current.raf = null;
      }
    };
  }, [sessionId, queryClient]);
}

function applyEvent(
  qc: QueryClient,
  sessionId: string,
  buffer: DeltaBuffer,
  event: LifecycleEvent
): void {
  switch (event.type) {
    case "message.started":
      onMessageStarted(qc, sessionId, event);
      return;
    case "message.part":
      // The snapshot's content is authoritative — drop anything buffered for it.
      buffer.pending.delete(event.part.id);
      onMessagePart(qc, sessionId, event);
      return;
    case "message.part.delta":
      if (event.delta.type === "text" || event.delta.type === "reasoning") {
        onPartDelta(qc, sessionId, buffer, event.partId, event.delta.text);
      }
      return;
    case "turn.ended":
      onTurnEnded(qc, sessionId, event);
      return;
    case "session.compaction":
      // The marker lives in its own table, alongside the message page.
      void qc.refetchQueries({ queryKey: messagesKey(sessionId), exact: true });
      return;
    default:
      // message.ended is a bracket marker; session.*/permission.*/error/raw
      // carry no message-cache state (session status arrives via q:delta).
      return;
  }
}
