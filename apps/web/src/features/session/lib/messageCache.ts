/**
 * Message Cache Utilities
 *
 * Shared merge logic for message cache updates.
 * Used by mergeMessageDelta (WS q:delta -> cache merge).
 */

import type { PaginatedMessages } from "../api/session.service";
import type { Message } from "../types";
import { isLocalMessage } from "./optimisticMessage";

/**
 * Custom delta merge for PaginatedMessages cache.
 * Used by useQuerySubscription's mergeDelta option so q:delta frames
 * merge correctly into the { messages, has_older, has_newer } shape
 * instead of treating the cache as a flat array.
 *
 * Deduplicates by message id, and retires the composer's optimistic bubble
 * against the echo it was standing in for — matched by `turn_id`, never by
 * "some delta arrived". A blanket strip made a rejected send disappear without
 * a trace: the backend writes no user row, so the typed message existed ONLY
 * here and the next unrelated delta deleted it.
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

  // Turns whose real user row just arrived — their local bubbles are done.
  const echoedTurns = new Set(
    incoming.filter((m) => m.role === "user" && m.turn_id).map((m) => m.turn_id)
  );
  const kept = paginated.messages.filter(
    (m) => !(isLocalMessage(m) && m.turn_id && echoedTurns.has(m.turn_id))
  );

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
