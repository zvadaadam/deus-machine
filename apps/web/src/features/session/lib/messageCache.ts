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

  // Remove optimistic placeholders — real messages replace them
  const realMessages = paginated.messages.filter((m) => !m.id.startsWith("optimistic-"));

  // Deduplicate: don't add messages that already exist
  const existingIds = new Set(realMessages.map((m) => m.id));
  const newMessages = (upserted as Message[]).filter((m) => !existingIds.has(m.id));

  return {
    messages: [...realMessages, ...newMessages],
    has_older: paginated.has_older,
    has_newer: false,
  };
}
