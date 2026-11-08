/** Deus binding: domain names, cache defaults and the cache-to-runtime lookup. */
import { QueryRuntimeClient } from "@deus/runtime-client/query";
import type { RuntimeIdentity, RuntimePorts as ClientPorts } from "@deus/runtime-client";
import type { QueryClient } from "@tanstack/react-query";
import type { QueryResource, CommandName } from "@shared/types/query-protocol";
import { createQueryClient } from "@/shared/api/queryClient";

export { RuntimeError } from "@deus/runtime-client";
export type {
  RuntimeIdentity,
  RuntimeSocket,
  RuntimeState,
  RuntimeFailureKind,
  QueryRequestInterceptor,
  ToolResponseInterceptor,
  EventCallback,
} from "@deus/runtime-client";
export type { DeltaMerge } from "@deus/runtime-client/query";

export interface RuntimePorts extends ClientPorts {
  queryClient?: QueryClient;
}
const owners = new WeakMap<QueryClient, RuntimeClient>();

export class RuntimeClient extends QueryRuntimeClient<QueryResource, CommandName> {
  constructor(identity: RuntimeIdentity, ports: RuntimePorts) {
    super(identity, {
      ...ports,
      queryClient: ports.queryClient ?? createQueryClient(),
      // The messages resource sends null as a delta-stream acknowledgment.
      acceptSnapshot: (resource, data) => resource !== "messages" || data !== null,
    });
    owners.set(this.queryClient, this);
  }
}
export function runtimeForQueryClient(cache: QueryClient): RuntimeClient | undefined {
  return owners.get(cache);
}
