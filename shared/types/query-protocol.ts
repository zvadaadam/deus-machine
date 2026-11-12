// The q: wire: the frames a client and a Deus host exchange over one socket.
//
// What a frame names (an operation or a stream) is declared in `shared/api`;
// this file is only the envelope that carries it. A client never builds these
// by hand: `call(op, input)` and the subscription hooks do.

import type { MutateResult } from "@deus/runtime-client";
import type { ProtocolEvent } from "../events";

export type { ProtocolEvent };
export { PROTOCOL_EVENTS } from "../events";

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
 * `q:delta` whenever it changes) or to a stream (answered with `q:event`s).
 * `after` resumes a resumable stream after the last seq the client saw.
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

/** Answer something an agent asked this client (a `tool:request` event). */
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

/** A live read's whole value, keyed by the subscription's id. */
export interface QSnapshotFrame {
  type: "q:snapshot";
  id: string;
  data: unknown;
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
 * An event. With `id`, it belongs to a stream subscription (and carries `seq`
 * on a resumable stream). Without, it is one of the events still sent to every
 * connection (`PROTOCOL_EVENTS`).
 */
export interface QEventFrame {
  type: "q:event";
  id?: string;
  event: string;
  data: unknown;
  seq?: number;
}

/** A resumable stream cannot say what the subscriber missed: read the resource again. */
export interface QResetFrame {
  type: "q:reset";
  id: string;
  seq: number;
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
  | QResetFrame
  | QErrorFrame;

// ---- Tool requests ----

/** The payload of the `tool:request` event: something an agent asks a client to do or answer. */
export interface ToolRequestEventData {
  requestId: string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}
