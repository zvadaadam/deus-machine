/**
 * Message Cache Utilities
 *
 * Shared merge logic for incremental message updates.
 * Used by useSessionEvents (Tauri event → incremental fetch)
 * and useSendMessage (onSettled → incremental fetch).
 */

import type { PaginatedMessages } from "../api/session.service";
import type { Message } from "../types";

/** Page size for message fetches (initial load + load-older + incremental) */
export const MESSAGE_PAGE_SIZE = 50;

/**
 * Merge newer messages into existing cache.
 * - Removes optimistic placeholder messages (id starts with "optimistic-")
 * - Deduplicates by message id (handles race between event fetch and settle fetch)
 * - Preserves has_older from old cache, takes has_newer from new response
 */
export function mergeNewerMessages(
  old: PaginatedMessages | undefined,
  newer: PaginatedMessages
): PaginatedMessages {
  if (!old) return newer;

  // Remove optimistic placeholders — real messages replace them
  const realMessages = old.messages.filter((m) => !m.id.startsWith("optimistic-"));

  // Deduplicate by id
  const existingIds = new Set(realMessages.map((m) => m.id));
  const newMessages = newer.messages.filter((m) => !existingIds.has(m.id));

  return {
    messages: [...realMessages, ...newMessages],
    has_older: old.has_older,
    has_newer: newer.has_newer,
  };
}

/**
 * Get the seq of the last real (non-optimistic) message in the cache.
 * Returns 0 if no real messages exist (fetch everything).
 */
export function getLastRealSeq(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i].id.startsWith("optimistic-")) {
      return messages[i].seq;
    }
  }
  return 0;
}
