/**
 * Message Cache Utilities
 *
 * Shared merge logic for message cache updates.
 * Used by mergeMessageDelta (WS q:delta -> cache merge).
 */

import type { PaginatedMessages } from "../api/session.service";
import type { Message } from "../types";

/**
 * Custom delta merge for PaginatedMessages cache.
 * Used by useQuerySubscription's mergeDelta option so q:delta frames
 * merge correctly into the { messages, has_older, has_newer } shape
 * instead of treating the cache as a flat array.
 *
 * Strips optimistic placeholders and deduplicates by message ID.
 */
export function mergeMessageDelta(
  old: unknown,
  upserted?: unknown[],
  // Messages are append-only — removed is unused but kept for interface compatibility
  _removed?: string[]
): unknown {
  if (!old || typeof old !== "object" || !("messages" in old)) return old;
  const paginated = old as PaginatedMessages;
  if (!upserted || upserted.length === 0) return old;

  // Remove optimistic placeholders — real messages replace them.
  const realMessages = paginated.messages.filter((m) => !m.id.startsWith("optimistic-"));

  const byId = new Map(realMessages.map((message) => [message.id, message]));
  for (const incoming of upserted as Message[]) {
    const existing = byId.get(incoming.id);
    byId.set(incoming.id, mergeMessage(existing, incoming));
  }

  return {
    messages: [...byId.values()].sort(compareMessages),
    has_older: paginated.has_older,
    has_newer: false,
  };
}

function mergeMessage(existing: Message | undefined, incoming: Message): Message {
  if (!existing) return incoming;

  return {
    ...existing,
    ...incoming,
    parts:
      incoming.parts && incoming.parts.length > 0
        ? incoming.parts
        : existing.parts && existing.parts.length > 0
          ? existing.parts
          : incoming.parts,
  };
}

function compareMessages(a: Message, b: Message): number {
  const aIndex = a.messageIndex ?? Math.max(0, a.seq - 1);
  const bIndex = b.messageIndex ?? Math.max(0, b.seq - 1);
  if (aIndex !== bIndex) return aIndex - bIndex;
  return a.seq - b.seq;
}
