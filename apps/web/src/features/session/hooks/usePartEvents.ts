/**
 * usePartEvents — Single-store streaming integration
 *
 * Listens to WS part lifecycle events (part:created, part:delta, part:done)
 * and directly mutates the TanStack Query cache for messages.
 *
 * Architecture:
 *   WS events → setQueryData() → TanStack cache → React renders
 *   DB loads  ────────────────→ TanStack cache → React renders
 *
 * Parts are stored as typed Part objects — no JSON serialization.
 * Delta flushes are just `part.text += delta` — direct object updates.
 */

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { onEvent } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import type { Message } from "@shared/types";
import type {
  PartCreatedEventData,
  PartDeltaEventData,
  PartDoneEventData,
} from "@shared/types/query-protocol";
import type { Part } from "@shared/messages/types";
import type { PaginatedMessages } from "../api/session.service";

// ---- Delta Buffer ----

interface DeltaBuffer {
  pending: Map<string, string>;
  raf: number | null;
}

// ---- Cache Mutation ----

/**
 * Find a message in the TanStack cache and update its parts.
 * If the message isn't in cache yet (shouldn't happen — message.created
 * q:delta arrives before part.created q:event), the update is skipped.
 */
function mutateParts(
  queryClient: QueryClient,
  sessionId: string,
  messageId: string,
  updater: (parts: Part[]) => Part[]
): void {
  const key = queryKeys.sessions.messages(sessionId);

  queryClient.setQueryData<PaginatedMessages>(key, (old) => {
    if (!old) return old;

    const msgIndex = old.messages.findIndex((m) => m.id === messageId);
    if (msgIndex === -1) return old;

    const msg = old.messages[msgIndex];
    const newParts = updater(msg.parts ?? []);
    if (newParts === msg.parts) return old;

    const newMessages = [...old.messages];
    newMessages[msgIndex] = { ...msg, parts: newParts };
    return { ...old, messages: newMessages };
  });
}

// ---- Hook ----

export function usePartEvents(sessionId: string | null): void {
  const queryClient = useQueryClient();
  const deltaRef = useRef<DeltaBuffer>({ pending: new Map(), raf: null });

  // Reset on session change
  useEffect(() => {
    deltaRef.current.pending.clear();
    if (deltaRef.current.raf !== null) {
      cancelAnimationFrame(deltaRef.current.raf);
      deltaRef.current.raf = null;
    }
  }, [sessionId]);

  // Subscribe to WS part events
  useEffect(() => {
    if (!sessionId) return;

    const unsub = onEvent((event: string, rawData: unknown) => {
      const data = rawData as Record<string, unknown>;
      if (data?.sessionId !== sessionId) return;

      if (import.meta.env.DEV) {
        console.log(
          `[PartEvents] ${event} msgId=${(data as any).messageId?.slice?.(-8) ?? ""} partId=${(data as any).partId?.slice?.(-8) ?? ""}`
        );
      }

      switch (event) {
        case "message:created":
          onMessageCreated(queryClient, sessionId, data as any);
          break;
        case "message:done":
          onMessageDone(queryClient, sessionId, data as any);
          break;
        case "part:created":
          onPartCreated(queryClient, sessionId, data as unknown as PartCreatedEventData);
          break;
        case "part:delta":
          onPartDelta(
            queryClient,
            sessionId,
            deltaRef.current,
            data as unknown as PartDeltaEventData
          );
          break;
        case "part:done":
          onPartDone(
            queryClient,
            sessionId,
            deltaRef.current,
            data as unknown as PartDoneEventData
          );
          break;
      }
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

// ---- Message Event Handlers ----

/** Create a message shell in cache so parts have a target when they arrive. */
function onMessageCreated(
  qc: QueryClient,
  sessionId: string,
  data: { messageId: string; role: string; parentToolCallId?: string }
): void {
  const key = queryKeys.sessions.messages(sessionId);

  qc.setQueryData<PaginatedMessages>(key, (old) => {
    if (!old) {
      return {
        messages: [
          {
            id: data.messageId,
            session_id: sessionId,
            seq: 0,
            role: data.role as "assistant",
            content: "",
            sent_at: new Date().toISOString(),
            parent_tool_use_id: data.parentToolCallId ?? null,
            parts: [],
          } as Message,
        ],
        has_older: false,
        has_newer: false,
      };
    }

    // Skip if message already exists (from q:delta)
    if (old.messages.some((m) => m.id === data.messageId)) return old;

    return {
      ...old,
      messages: [
        ...old.messages,
        {
          id: data.messageId,
          session_id: sessionId,
          seq: 0,
          role: data.role as "assistant",
          content: "",
          sent_at: new Date().toISOString(),
          parent_tool_use_id: data.parentToolCallId ?? null,
          parts: [],
        } as Message,
      ],
    };
  });
}

/** Update stop_reason and repair parts on a completed message.
 *  message:done carries the final parts array — use it to fill gaps
 *  for clients that subscribed mid-stream and missed some part events. */
function onMessageDone(
  qc: QueryClient,
  sessionId: string,
  data: { messageId: string; stopReason?: string; parts?: Part[]; parentToolCallId?: string }
): void {
  const key = queryKeys.sessions.messages(sessionId);

  qc.setQueryData<PaginatedMessages>(key, (old) => {
    if (!old) return old;

    const msgIndex = old.messages.findIndex((m) => m.id === data.messageId);
    if (msgIndex === -1) return old;

    const msg = old.messages[msgIndex];
    const updates: Partial<Message> = { stop_reason: data.stopReason ?? null };

    // Repair parts if message:done carries more than the cache has
    if (data.parts && data.parts.length > (msg.parts?.length ?? 0)) {
      updates.parts = data.parts;
    }
    if (data.parentToolCallId) {
      updates.parent_tool_use_id = data.parentToolCallId;
    }

    const newMessages = [...old.messages];
    newMessages[msgIndex] = { ...msg, ...updates };
    return { ...old, messages: newMessages };
  });
}

// ---- Part Event Handlers ----

function onPartCreated(qc: QueryClient, sessionId: string, data: PartCreatedEventData): void {
  const { messageId, part } = data;

  mutateParts(qc, sessionId, messageId, (parts) => {
    const existing = parts.find((p) => p.id === part.id);
    return existing ? parts.map((p) => (p.id === part.id ? part : p)) : [...parts, part];
  });
}

function onPartDelta(
  qc: QueryClient,
  sessionId: string,
  buffer: DeltaBuffer,
  data: PartDeltaEventData
): void {
  const { partId, delta } = data;

  const existing = buffer.pending.get(partId);
  buffer.pending.set(partId, existing ? existing + delta : delta);

  if (buffer.raf === null) {
    buffer.raf = requestAnimationFrame(() => flushDeltas(qc, sessionId, buffer));
  }
}

function flushDeltas(qc: QueryClient, sessionId: string, buffer: DeltaBuffer): void {
  buffer.raf = null;
  if (buffer.pending.size === 0) return;

  const key = queryKeys.sessions.messages(sessionId);
  const deltas = new Map(buffer.pending);
  buffer.pending.clear();

  qc.setQueryData<PaginatedMessages>(key, (old) => {
    if (!old) return old;

    let mutated = false;
    const newMessages = old.messages.map((msg) => {
      if (!msg.parts) return msg;

      let partsChanged = false;
      const newParts = msg.parts.map((part) => {
        const delta = deltas.get(part.id);
        if (!delta) return part;

        // Direct object mutation — no JSON parse/stringify
        if ((part.type === "TEXT" || part.type === "REASONING") && "text" in part) {
          partsChanged = true;
          return { ...part, text: (part as any).text + delta };
        }
        return part;
      });

      if (!partsChanged) return msg;
      mutated = true;
      return { ...msg, parts: newParts };
    });

    return mutated ? { ...old, messages: newMessages } : old;
  });
}

function onPartDone(
  qc: QueryClient,
  sessionId: string,
  buffer: DeltaBuffer,
  data: PartDoneEventData
): void {
  const { messageId, partId, part } = data;

  buffer.pending.delete(partId);

  mutateParts(qc, sessionId, messageId, (parts) => {
    const existing = parts.find((p) => p.id === partId);
    return existing ? parts.map((p) => (p.id === partId ? part : p)) : [...parts, part];
  });
}
