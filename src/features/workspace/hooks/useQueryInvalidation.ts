/**
 * Global query invalidation hook (desktop only).
 *
 * Listens for "query:invalidate" Tauri events emitted by the Rust backend
 * when the Node.js backend calls invalidate(). Maps resource names to
 * React Query cache keys and invalidates them.
 *
 * This replaces manual stats/workspace invalidation scattered across
 * mutation hooks and event handlers.
 */

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { QUERY_RESOURCES, type QueryResource } from "@shared/types/query-protocol";
import { isTauriEnv, listen, createListenerGroup, QUERY_INVALIDATE } from "@/platform/tauri";
import { queryKeys } from "@/shared/api/queryKeys";

/** Workspace sub-keys that are expensive (git ops, external APIs) and should
 *  NOT be swept when the backend invalidates the "workspaces" resource.
 *  Only sidebar list (by-repo) and detail queries are cheap enough to refetch. */
const WORKSPACE_EXPENSIVE_SUBKEYS = new Set([
  "diff-stats",
  "diff-files",
  "uncommitted-files",
  "last-turn-files",
  "diff-file",
  "pr-status",
  "pen-files",
  "system-prompt",
  "manifest",
]);

/**
 * Dispatches React Query invalidations for the given resource names.
 * Extracted as a pure function for testability.
 */
export function dispatchInvalidation(
  queryClient: QueryClient,
  resources: string[]
): void {
  for (const resource of resources) {
    // Filter out unknown strings before matching — the Tauri event payload
    // is untyped, but only valid QueryResource values should be dispatched.
    if (!(QUERY_RESOURCES as readonly string[]).includes(resource)) continue;

    try {
      match(resource as QueryResource)
        .with("workspaces", () => {
          // Invalidate sidebar list + workspace detail, but NOT expensive
          // per-workspace queries (diff stats, PR status, etc.).
          // queryKeys.workspaces.all is ["workspaces"] which prefix-matches
          // all workspace sub-keys — we must be selective.
          queryClient.invalidateQueries({
            queryKey: queryKeys.workspaces.all,
            predicate: (query) => {
              const key = query.queryKey;
              return !(key.length >= 2 && WORKSPACE_EXPENSIVE_SUBKEYS.has(key[1] as string));
            },
          });
        })
        .with("stats", () => {
          queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
        })
        .with("sessions", () => {
          // Invalidate session lists and details, but NOT message caches.
          // queryKeys.sessions.all is ["sessions"] which prefix-matches
          // ["sessions", "messages", id] — we must be selective.
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.all,
            predicate: (query) => {
              const key = query.queryKey;
              return !(key.length >= 2 && key[1] === "messages");
            },
          });
        })
        .with("messages", () => {
          // No-op: message cache updates are handled by useSessionEvents
          // via incremental fetch (session:message Tauri events from sidecar).
        })
        .exhaustive();
    } catch (error) {
      console.error(`[QueryInvalidation] Failed to dispatch for "${resource}":`, error);
    }
  }
}

export function useQueryInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriEnv) return;

    const listeners = createListenerGroup();

    listeners.register(
      listen(QUERY_INVALIDATE, (event) => {
        dispatchInvalidation(queryClient, event.payload.resources);
      })
    );

    return () => listeners.cleanup();
  }, [queryClient]);
}
