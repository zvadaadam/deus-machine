/** Deus binding: the typed operations, cache defaults and the cache-to-runtime lookup. */
import { QueryRuntimeClient } from "@deus/runtime-client/query";
import {
  RuntimeError,
  type RuntimeIdentity,
  type RuntimePorts as ClientPorts,
} from "@deus/runtime-client";
import type { AnyOp, InputOf, OutputOf } from "@shared/api/op";
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

/** The host refused an operation: what it said, and the status and details it gave. */
export class OpError extends RuntimeError {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super("rejected", message);
    this.name = "OpError";
  }
}

export interface CallOptions {
  timeoutMs?: number;
}
/** The input is optional when the operation needs none of it. */
export type CallArgs<O extends AnyOp> =
  Record<never, never> extends InputOf<O>
    ? [input?: InputOf<O>, options?: CallOptions]
    : [input: InputOf<O>, options?: CallOptions];
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

  /**
   * Ask this host to run an operation from `shared/api`. A read may be asked
   * again; a write is sent once, and a reply lost on the way rejects as
   * `unknown-outcome` rather than being retried. A refusal throws `OpError`
   * (writes) or a `rejected` `RuntimeError` (reads).
   */
  call = async <O extends AnyOp>(op: O, ...args: CallArgs<O>): Promise<OutputOf<O>> => {
    const [input, options] = args as [Record<string, unknown> | undefined, CallOptions?];
    if (op.kind === "read") return this.sendRequest<OutputOf<O>>(op.name, input, options);
    const result = await this.sendMutate<OutputOf<O>>(op.name, input ?? {}, options?.timeoutMs);
    if (!result.success) {
      throw new OpError(result.error || `${op.name} failed`, result.status, result.details);
    }
    return result.data as OutputOf<O>;
  };
}
export function runtimeForQueryClient(cache: QueryClient): RuntimeClient | undefined {
  return owners.get(cache);
}
