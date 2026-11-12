import { hashKey, type QueryClient, type QueryKey } from "@tanstack/query-core";
import { RuntimeClient } from "./client";
import type { RuntimeIdentity, RuntimePorts } from "./types";

export type DeltaMerge = (old: unknown, upserted?: unknown[], removed?: string[]) => unknown;
export interface QueryRuntimePorts extends RuntimePorts {
  /** A dedicated cache for this runtime. Its defaults are application policy. */
  queryClient: QueryClient;
  /** Some resources use snapshots as acknowledgments rather than cache values. */
  acceptSnapshot?: (resource: string, data: unknown) => boolean;
}
type Binding = { count: number; queryKey: QueryKey; stop: () => void };

/** Optional cache integration. Importing the core client does not load TanStack. */
export class QueryRuntimeClient<Resource extends string = string> extends RuntimeClient<Resource> {
  readonly queryClient: QueryClient;
  private bindings = new Map<string, Binding>();
  private acceptSnapshot: NonNullable<QueryRuntimePorts["acceptSnapshot"]>;

  constructor(identity: RuntimeIdentity, ports: QueryRuntimePorts) {
    super(identity, ports);
    this.queryClient = ports.queryClient;
    this.acceptSnapshot = ports.acceptSnapshot ?? (() => true);
    this.onStateChange((state) => {
      if (state === "online") return;
      for (const binding of this.bindings.values()) {
        void this.queryClient.invalidateQueries({
          queryKey: binding.queryKey,
          exact: true,
          refetchType: "none",
        });
      }
    });
    this.onDispose(() => {
      void this.queryClient.cancelQueries();
      this.queryClient.clear();
      this.bindings.clear();
    });
  }

  /** One projection per cache key, regardless of how many components observe it. */
  retainQuery = (
    resource: Resource,
    params: Record<string, unknown> | undefined,
    queryKey: QueryKey,
    merge: DeltaMerge = mergeListDelta
  ): (() => void) => {
    if (this.ended()) return () => {};
    const key = hashKey([resource, params ?? {}, queryKey]);
    let binding = this.bindings.get(key);
    if (!binding) {
      const cacheKey = structuredClone(queryKey);
      const stop = this.subscribe(
        resource,
        params,
        (data) => {
          if (this.acceptSnapshot(resource, data)) this.queryClient.setQueryData(cacheKey, data);
        },
        (upserted, removed) => {
          if (upserted || removed)
            this.queryClient.setQueryData(cacheKey, (old: unknown) =>
              merge(old, upserted, removed)
            );
        }
      );
      binding = { count: 0, queryKey: cacheKey, stop };
      this.bindings.set(key, binding);
    }
    binding.count++;
    const entry = binding;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--entry.count === 0) {
        entry.stop();
        this.bindings.delete(key);
      }
    };
  };

  override diagnostics() {
    return {
      ...super.diagnostics(),
      observers: [...this.bindings.values()].reduce((count, binding) => count + binding.count, 0),
    };
  }
}

function mergeListDelta(old: unknown, upserted?: unknown[], removed?: string[]): unknown {
  if (!Array.isArray(old)) return old;
  const idOf = (item: unknown): unknown =>
    typeof item === "object" && item !== null && "id" in item ? item.id : undefined;
  const removedIds = new Set(removed);
  const result: unknown[] = old.filter((item) => !removedIds.has(idOf(item) as string));
  for (const item of upserted ?? []) {
    const id = idOf(item);
    const index = id === undefined ? -1 : result.findIndex((value) => idOf(value) === id);
    if (index < 0) result.push(item);
    else result[index] = item;
  }
  return result;
}
