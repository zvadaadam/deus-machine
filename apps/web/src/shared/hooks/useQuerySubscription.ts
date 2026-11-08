import { useEffect } from "react";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws/query-protocol-client";
import type { DeltaMerge } from "@/platform/ws/runtime-client";
import type { QueryResource } from "@shared/types/query-protocol";

interface UseQuerySubscriptionOptions {
  queryKey: QueryKey;
  params?: Record<string, unknown>;
  enabled?: boolean;
  /** A pure projection of this resource's delta into its cache shape. */
  mergeDelta?: DeltaMerge;
}

/**
 * Retain a runtime-owned subscription and cache projection. Components share
 * both the wire subscription and its cache write. Reconnect belongs to the
 * client, so a temporary outage never mounts another subscription per observer.
 */
export function useQuerySubscription(
  resource: QueryResource,
  options: UseQuerySubscriptionOptions
): void {
  const { queryKey, params, enabled = true, mergeDelta } = options;
  const cache = useQueryClient();
  const runtime = runtimeForQueryClient(cache) ?? getRuntimeClient();
  const key = hashKey([resource, params ?? {}, queryKey]);
  useEffect(() => {
    if (!enabled) return;
    return runtime.retainQuery(resource, params, queryKey, mergeDelta);
    // Values are serialized together; a changed cache key is a new projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, key, enabled, mergeDelta]);
}
