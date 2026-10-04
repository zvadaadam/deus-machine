/**
 * Hook that subscribes to a query protocol resource via WebSocket and writes
 * snapshots/deltas directly into the React Query cache.
 *
 * This bypasses the HTTP refetch cycle: instead of
 *   event -> invalidate -> HTTP GET -> render
 * it becomes:
 *   WS q:snapshot -> setQueryData -> render
 *
 * The HTTP queryFn remains as fallback for initial load (before WS connects).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { subscribe, isConnected, onConnectionChange } from "@/platform/ws";
import type { QueryResource } from "@shared/types/query-protocol";

interface UseQuerySubscriptionOptions {
  /** React Query cache key to write data into. */
  queryKey: QueryKey;
  /** Optional params passed to the backend query (e.g., { state: "ready,initializing" }). */
  params?: Record<string, unknown>;
  /** Disable the subscription (e.g., when data isn't needed). Defaults to true. */
  enabled?: boolean;
  /** Custom delta merge. Receives old cache value + delta items, returns new cache value.
   *  When provided, replaces the default flat-array merge for q:delta frames. */
  mergeDelta?: (old: unknown, upserted?: unknown[], removed?: string[]) => unknown;
}

/**
 * Subscribe to a query protocol resource and write snapshots/deltas
 * directly into the React Query cache.
 *
 * On q:snapshot: replaces the entire cache entry via setQueryData.
 * On q:delta: merges upserted items and removes removed items (for list resources).
 *
 * IMPORTANT: queryKey must be a pure function of (resource, params). The queryKey
 * is stored in a ref and not included in the subscription effect's dependency
 * array — if queryKey drifts independently from params, the snapshot would write
 * to the wrong cache entry.
 */
export function useQuerySubscription(
  resource: QueryResource,
  options: UseQuerySubscriptionOptions
): void {
  const { queryKey, params, enabled = true, mergeDelta } = options;
  const queryClient = useQueryClient();

  // Track WS connection state so the subscription effect re-runs when
  // the connection comes up. Without this, hooks that mount before WS
  // connects would return early and never subscribe (staleTime: Infinity
  // means the HTTP fallback data would never refresh).
  const [wsConnected, setWsConnected] = useState(isConnected());
  useEffect(() => {
    return onConnectionChange(setWsConnected);
  }, []);

  // Stable string key for params so effect doesn't re-run on referential changes
  const stableParamsKey = useMemo(() => (params ? JSON.stringify(params) : ""), [params]);

  // Use refs for callbacks to avoid re-subscribing on every render
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  const mergeDeltaRef = useRef(mergeDelta);
  mergeDeltaRef.current = mergeDelta;

  useEffect(() => {
    if (!enabled || !wsConnected) return;

    const unsubscribe = subscribe(
      resource,
      params,
      // onSnapshot: replace entire cache entry.
      // Delta-only resources (messages) don't send a snapshot — they send
      // q:subscribed instead and the HTTP queryFn supplies initial data.
      (data) => {
        queryClientRef.current.setQueryData(queryKeyRef.current, data);
      },
      // onDelta: merge incremental updates (for list resources like messages)
      (upserted, removed) => {
        if (!upserted && !removed) return;

        queryClientRef.current.setQueryData(queryKeyRef.current, (old: unknown) => {
          // Custom merge strategy (e.g., PaginatedMessages for message cache)
          if (mergeDeltaRef.current) {
            return mergeDeltaRef.current(old, upserted, removed);
          }

          // Default: flat array merge
          if (!Array.isArray(old)) return old;

          let result = [...old];

          // Remove items by ID
          if (removed && removed.length > 0) {
            const removeSet = new Set(removed);
            result = result.filter(
              (item: unknown) =>
                !(
                  typeof item === "object" &&
                  item !== null &&
                  "id" in item &&
                  removeSet.has((item as { id: string }).id)
                )
            );
          }

          // Upsert items (update existing or append new)
          if (upserted && upserted.length > 0) {
            for (const item of upserted) {
              if (typeof item !== "object" || item === null || !("id" in item)) {
                result.push(item);
                continue;
              }
              const itemId = (item as { id: string }).id;
              const idx = result.findIndex(
                (existing: unknown) =>
                  typeof existing === "object" &&
                  existing !== null &&
                  "id" in existing &&
                  (existing as { id: string }).id === itemId
              );
              if (idx >= 0) {
                result[idx] = item;
              } else {
                result.push(item);
              }
            }
          }

          return result;
        });
      }
    );

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, enabled, stableParamsKey, wsConnected]);
}
