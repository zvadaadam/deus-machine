/**
 * What the sidebar's session status reverts to when a send fails.
 *
 * The composer optimistically paints the session "working" before the command
 * is answered, so every failed send has to put that back. WHICH way to put it
 * back depends on whether the server got a word in, and the two cases are not
 * interchangeable:
 *
 *   The server ANSWERED (a rejection). It is authoritative, and it has already
 *   said so on the wire — `handleSendMessage` writes the session's status and
 *   calls `invalidate` BEFORE it throws, so the q:snapshot carrying the real
 *   status is written to the socket ahead of the `q:command_ack` that rejects
 *   us. By the time this runs, the cache already holds the truth. Restoring the
 *   pre-send snapshot over it is a straight overwrite of newer data with older
 *   — and `staleTime: Infinity` means nothing ever corrects it, so the sidebar
 *   sits on "idle" for a session the backend has flagged `error` until the app
 *   is reloaded. Refetch instead.
 *
 *   The TRANSPORT died. Nothing was pushed, because there was no socket to push
 *   down; the snapshot IS the freshest thing anyone has, and a refetch would
 *   only be a request with nowhere to go. Restore it.
 *
 * Both rejection flavors take the refetch branch, including `turnActive` — the
 * one where the backend deliberately leaves the status alone. "Alone" there
 * means "working", because another client's turn really is running; the
 * pre-send snapshot says "idle", which is just as wrong as it is in the error
 * case. The optimistic PROMPT is retired separately and unconditionally by
 * `dropOptimisticMessage`, so nothing here needs to touch the message page —
 * one send's bubble goes, and no message query is marked stale for it.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** A rejection the server understood — resending it would only reject again. */
export class SendRejectedError extends Error {}

/** The `["workspaces", "by-repo", state]` entries snapshotted before a send. */
export type WorkspaceSnapshot = Array<[QueryKey, unknown]>;

/**
 * The PREFIX of every by-repo key, matching the `getQueriesData` that took the
 * snapshot. `queryKeys.workspaces.byRepo()` is the wrong tool here: it fills the
 * `state` slot with `undefined`, and a filter key with an explicit `undefined`
 * at index 2 matches only a query whose own index 2 is `undefined` — not the
 * `"active"` / `"archived"` variants the sidebar actually registers.
 */
const WORKSPACES_BY_REPO: QueryKey = ["workspaces", "by-repo"];

/** Undo the composer's optimistic "working" paint after a failed send. */
export function rollbackSendStatus(
  queryClient: QueryClient,
  error: unknown,
  snapshot: WorkspaceSnapshot | undefined
): void {
  const refetch = (): void => {
    void queryClient.invalidateQueries({ queryKey: WORKSPACES_BY_REPO });
  };

  // The server spoke; its status is already in the cache and outranks ours.
  if (error instanceof SendRejectedError) return refetch();

  if (snapshot?.length) {
    snapshot.forEach(([key, data]) => queryClient.setQueryData(key, data));
    return;
  }
  refetch();
}
