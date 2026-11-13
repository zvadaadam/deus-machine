import { useEffect } from "react";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws/query-protocol-client";
import type { DeltaMerge } from "@/platform/ws/runtime-client";
import type { LiveName } from "@shared/api";
import type { InputOf, Op, OpKind } from "@shared/api/op";
import type { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any live read, whatever it answers
type LiveOp = Op<string, z.ZodType, any, OpKind, true>;

interface UseQuerySubscriptionOptions<O extends LiveOp = LiveOp> {
  queryKey: QueryKey;
  params?: InputOf<O>;
  enabled?: boolean;
  /** A pure projection of this resource's delta into its cache shape. */
  mergeDelta?: DeltaMerge;
}

/**
 * Retain a runtime-owned subscription and cache projection. Components share
 * both the wire subscription and its cache write. Reconnect belongs to the
 * client, so a temporary outage never mounts another subscription per observer.
 */
export function useQuerySubscription<O extends LiveOp>(
  op: O,
  options: UseQuerySubscriptionOptions<O>
): void {
  const { queryKey, enabled = true, mergeDelta } = options;
  const params = options.params as Record<string, unknown> | undefined;
  const resource = op.name as LiveName;
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
