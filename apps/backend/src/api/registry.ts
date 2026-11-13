/**
 * The one place a client's request meets the code that answers it.
 *
 * Every operation in `shared/api` has exactly one handler, written beside the
 * others of its domain (`api/workspaces.ts`, …). The registry looks the handler
 * up, checks the input against the operation's schema, and calls it with who is
 * asking. The query engine carries frames; it no longer knows any operation.
 */

import type { AnyOp, OpKind, OutputOf, ParsedInputOf } from "@shared/api/op";
import { describeInputError } from "@shared/api/op";
import { NotFoundError, ValidationError } from "../lib/errors";

/** Who is asking. Filled by the transport once a connection is admitted. */
export interface Caller {
  /** The paired device this connection belongs to; null for this computer's own window. */
  deviceId: string | null;
  /** Arrived through the relay rather than a socket on this computer or its network. */
  relayed: boolean;
}

export interface Ctx {
  caller: Caller;
}

/** This computer's own window: what code that is not answering a frame acts as. */
export const LOCAL_CALLER: Caller = { deviceId: null, relayed: false };

/**
 * A live read answers synchronously: it is re-run for every subscriber inside
 * `invalidate()`, which pushes before it returns. Everything else may be async.
 */
type Run<O extends AnyOp> = (
  input: ParsedInputOf<O>,
  ctx: Ctx
) => O extends { live: true } ? OutputOf<O> : OutputOf<O> | Promise<OutputOf<O>>;

export interface Handler {
  op: AnyOp;
  run: (input: unknown, ctx: Ctx) => unknown;
}

/** Pair an operation with the function that answers it. The pairing is what types both. */
export function handle<O extends AnyOp>(op: O, run: Run<O>): Handler {
  return { op, run: run as Handler["run"] };
}

export class Registry {
  private readonly handlers = new Map<string, Handler>();

  constructor(handlers: Handler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.op.name)) {
        throw new Error(`Two handlers answer ${handler.op.name}`);
      }
      this.handlers.set(handler.op.name, handler);
    }
  }

  find(name: string): AnyOp | undefined {
    return this.handlers.get(name)?.op;
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  /** Validate, then run. `kind` is the kind of frame that carried the request. */
  async run(name: string, kind: OpKind, input: unknown, ctx: Ctx): Promise<unknown> {
    const { handler, data } = this.admit(name, kind, input);
    return handler.run(data, ctx);
  }

  /** A live read, answered in this tick (see `Run`). */
  runLive(name: string, input: unknown, ctx: Ctx): unknown {
    const { handler, data } = this.admit(name, "read", input);
    if (!handler.op.live) throw new ValidationError(`${name} cannot be subscribed to`);
    return handler.run(data, ctx);
  }

  private admit(name: string, kind: OpKind, input: unknown): { handler: Handler; data: unknown } {
    const handler = this.handlers.get(name);
    if (!handler) throw new NotFoundError(`Unknown operation: ${name}`);
    if (handler.op.kind !== kind) {
      throw new ValidationError(`${name} is a ${handler.op.kind}, not a ${kind}`);
    }
    const raw = input ?? {};
    const parsed = handler.op.input.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        describeInputError(handler.op, parsed.error, raw),
        parsed.error.issues
      );
    }
    return { handler, data: parsed.data };
  }
}
