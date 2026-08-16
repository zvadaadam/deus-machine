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
 * Deduplicating by message id is the whole of it. The composer's optimistic
 * bubble carries the id the engine's echo will carry (`echoMessageId`), so the
 * persisted row arriving here IS that row — it dedupes, rather than needing to
 * be matched against a look-alike by `turn_id` and swapped in. A bubble is
 * retired only by `dropOptimisticMessage`, so a rejected send never disappears
 * on the next unrelated delta.
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

  const incoming = upserted as Message[];
  const kept = paginated.messages;

  // Deduplicate: don't add messages that already exist
  const existingIds = new Set(kept.map((m) => m.id));
  const newMessages = incoming.filter((m) => !existingIds.has(m.id));

  return {
    messages: [...kept, ...newMessages],
    // Compactions are positional siblings of messages, not deltas — a message
    // delta must never drop the dividers already in the page.
    compactions: paginated.compactions,
    has_older: paginated.has_older,
    has_newer: false,
  };
}
