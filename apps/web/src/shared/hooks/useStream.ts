import { useEffect, useLayoutEffect, useRef } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import type { AnyStream, EventOf, FilterOf } from "@shared/api/stream";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws/query-protocol-client";

/**
 * Follow a stream from `shared/api` while mounted. `filter` narrows it (for
 * example to one session); pass `null` to not listen yet. `onReset` runs when
 * events may have been missed (a reconnect the host could not resume). The
 * handlers may change between renders without the subscription being made again.
 */
export function useStream<S extends AnyStream>(
  stream: S,
  filter: FilterOf<S> | null,
  onEvent: (event: EventOf<S>) => void,
  onReset?: () => void
): void {
  const cache = useQueryClient();
  const runtime = runtimeForQueryClient(cache) ?? getRuntimeClient();
  const handlers = useRef({ onEvent, onReset });
  useLayoutEffect(() => {
    handlers.current = { onEvent, onReset };
  });
  const key = filter === null ? null : hashKey([stream.name, filter]);
  useEffect(() => {
    if (filter === null) return;
    return runtime.follow(stream, filter, (event) => handlers.current.onEvent(event), {
      onReset: () => handlers.current.onReset?.(),
    });
    // The filter is compared by value through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, stream, key]);
}
