// The q: wire: the frames a client and a Deus host exchange over one socket.
//
// What a frame names (an operation or a stream) is declared in `shared/api`;
// this file is only the envelope that carries it. A client never builds these
// by hand: `call(op, input)` and the subscription hooks do.

import type { MutateResult } from "@deus/runtime-client";

// ---- Client → host ----

/** Ask a read. Answered once with `q:response`, or `q:error`. */
export interface QRequestFrame {
  type: "q:request";
  id: string;
  resource: string;
  params?: Record<string, unknown>;
}

/**
 * Subscribe to a live read (answered with `q:snapshot`, then `q:snapshot` or
 * `q:delta` whenever it changes) or to a stream (answered with `q:subscribed`,
 * then `q:event`s).
 * A client that returns after a lost connection says where it stopped
 * (`after`: the last `seq` of a stream, the last `cursor` of a read that has
 * one) and is sent what followed, or a `q:reset` when the host cannot say.
 */
export interface QSubscribeFrame {
  type: "q:subscribe";
  id: string;
  resource: string;
  params?: Record<string, unknown>;
  after?: number;
}

export interface QUnsubscribeFrame {
  type: "q:unsubscribe";
  id: string;
}

/** Ask a write. Answered once with `q:mutate_result`; never sent twice. */
export interface QMutateFrame {
  type: "q:mutate";
  id: string;
  action: string;
  params: Record<string, unknown>;
}

/** Answer something an agent asked this client (a request on `toolRequests`). */
export type QToolResponseFrame =
  | { type: "q:tool_response"; requestId: string; result: unknown; error?: never }
  | { type: "q:tool_response"; requestId: string; error: string; result?: never };

export type QClientFrame =
  | QRequestFrame
  | QSubscribeFrame
  | QUnsubscribeFrame
  | QMutateFrame
  | QToolResponseFrame;

// ---- Host → client ----

export interface QResponseFrame {
  type: "q:response";
  id: string;
  data: unknown;
}

/**
 * A live read's whole value, keyed by the subscription's id. A read that sends
 * rows since a cursor (`messages`) answers with where it stands instead.
 */
export interface QSnapshotFrame {
  type: "q:snapshot";
  id: string;
  data: unknown;
  cursor?: number;
}

/** A change to a live read: rows to upsert by id, ids to remove. */
export interface QDeltaFrame {
  type: "q:delta";
  id: string;
  upserted?: unknown[];
  removed?: string[];
  cursor?: number;
}

export interface QMutateResultFrame<T = unknown> extends MutateResult<T> {
  type: "q:mutate_result";
  id: string;
}

/**
 * One event of a stream, for the subscription `id`. `seq` numbers it within
 * its scope on a resumable stream (an event the stream does not keep carries
 * the number of the kept one before it).
 */
export interface QEventFrame {
  type: "q:event";
  id: string;
  event: string;
  data: unknown;
  seq?: number;
}

/**
 * A stream subscription is in place. `seq` is where its scope stands on a
 * resumable stream: the place a client returns to if nothing arrives meanwhile.
 */
export interface QSubscribedFrame {
  type: "q:subscribed";
  id: string;
  seq?: number;
}

/**
 * A stream cannot say what the subscriber missed since the event it named:
 * it reads the state again. `seq` is where the stream stands now, when it has
 * kept anything under that scope.
 */
export interface QResetFrame {
  type: "q:reset";
  id: string;
  seq?: number;
}

/** A read or a subscription was refused. */
export interface QErrorFrame {
  type: "q:error";
  id: string;
  code: string;
  message: string;
}

export type QServerFrame =
  | QResponseFrame
  | QSnapshotFrame
  | QDeltaFrame
  | QMutateResultFrame
  | QEventFrame
  | QSubscribedFrame
  | QResetFrame
  | QErrorFrame;

// ---- Tool requests ----

/** Something an agent asks a client to do or answer (sent on `toolRequests`). */
export interface ToolRequestEventData {
  requestId: string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}
