// Query protocol — WebSocket wire format for the cloud relay.
// All frame types prefixed with "q:" so they route cleanly in the ws.service dispatcher.
//
// Domain constants (QUERY_RESOURCES, MUTATION_NAMES, COMMAND_NAMES, PROTOCOL_EVENTS)
// live in shared/events.ts — the single source of truth for all app events
// and resources. This file only defines the wire format that carries them.

import type {
  QueryResource,
  RequestResource,
  MutationName,
  CommandName,
  ProtocolEvent,
} from "../events";

// Re-export so existing `import { QueryResource } from "query-protocol"` still works.
export type { QueryResource, RequestResource, MutationName, CommandName, ProtocolEvent };
export {
  QUERY_RESOURCES,
  REQUEST_RESOURCES,
  MUTATION_NAMES,
  COMMAND_NAMES,
  PROTOCOL_EVENTS,
} from "../events";

// ---- Client → Server Frames ----

/** Client requests data (one-shot). Accepts both subscribable and request-only resources. */
export interface QRequestFrame {
  type: "q:request";
  id: string;
  resource: RequestResource;
  params?: Record<string, unknown>;
}

/** Client subscribes to live updates for a resource.
 *
 * Most resources send an initial `q:snapshot` with current data, then `q:delta`s.
 * Delta-only resources (currently: `messages`) skip the initial snapshot and send
 * only a `q:subscribed` ack — clients are expected to load history via a separate
 * `q:request` for the same resource (or, on web, via HTTP). This keeps the subscribe
 * path cheap when history is large and the client may have already cached it. */
export interface QSubscribeFrame {
  type: "q:subscribe";
  id: string;
  resource: QueryResource;
  params?: Record<string, unknown>;
}

/** Client unsubscribes by subscription ID (no resource/params needed). */
export interface QUnsubscribeFrame {
  type: "q:unsubscribe";
  id: string;
}

/** Client requests a mutation. Field is `action`, not `mutation`. */
export interface QMutateFrame {
  type: "q:mutate";
  id: string;
  action: MutationName;
  params: Record<string, unknown>;
}

/** Client sends an async command (e.g. sendMessage, stopSession). */
export interface QCommandFrame {
  type: "q:command";
  id: string;
  command: CommandName;
  params: Record<string, unknown>;
}

/** Client responds to a tool relay request (q:event tool:request → q:tool_response). */
export interface QToolResponseSuccessFrame {
  type: "q:tool_response";
  requestId: string;
  result: unknown;
  error?: never;
}

export interface QToolResponseErrorFrame {
  type: "q:tool_response";
  requestId: string;
  error: string;
  result?: never;
}

export type QToolResponseFrame = QToolResponseSuccessFrame | QToolResponseErrorFrame;

/** All frames a client can send. */
export type QClientFrame =
  | QRequestFrame
  | QSubscribeFrame
  | QUnsubscribeFrame
  | QMutateFrame
  | QCommandFrame
  | QToolResponseFrame;

// ---- Server → Client Frames ----

/** Server returns data for a one-shot request. */
export interface QResponseFrame {
  type: "q:response";
  id: string;
  data: unknown;
}

/** Server pushes a full snapshot to a subscriber (keyed by subscription ID). */
export interface QSnapshotFrame {
  type: "q:snapshot";
  id: string;
  data: unknown;
  cursor?: number;
}

/** Server acks a subscribe when the resource is delta-only (no initial snapshot).
 *  Sent instead of `q:snapshot` for resources where the client loads history
 *  separately (see doc on QSubscribeFrame). Deltas follow via `q:delta`. */
export interface QSubscribedFrame {
  type: "q:subscribed";
  id: string;
  cursor?: number;
}

/** Server pushes incremental update (keyed by subscription ID). */
export interface QDeltaFrame {
  type: "q:delta";
  id: string;
  upserted?: unknown[];
  removed?: string[];
  cursor?: number;
}

/** Server returns mutation result. Uses `success`, not `ok`. */
export interface QMutateResultFrame {
  type: "q:mutate_result";
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Server tells clients to refetch stale resources. */
export interface QInvalidateFrame {
  type: "q:invalidate";
  resources: QueryResource[];
}

/** Server acknowledges an async command. */
export interface QCommandAckFrame {
  type: "q:command_ack";
  id: string;
  accepted: boolean;
  commandId?: string;
  error?: string;
}

/** Server pushes an ephemeral event (no subscription needed). */
export interface QEventFrame {
  type: "q:event";
  event: ProtocolEvent;
  data: unknown;
}

/** Server error for a specific request. */
export interface QErrorFrame {
  type: "q:error";
  id: string;
  code: string;
  message: string;
}

/** All frames a server can send. */
export type QServerFrame =
  | QResponseFrame
  | QSnapshotFrame
  | QSubscribedFrame
  | QDeltaFrame
  | QMutateResultFrame
  | QCommandAckFrame
  | QEventFrame
  | QInvalidateFrame
  | QErrorFrame;

// ---- Tool Relay Event Payload ----

/** Payload shape for q:event with event: "tool:request".
 *  Sent by the backend when relaying a tool request from the agent to the frontend.
 *  Derived from the canonical ToolRequestEvent (shared/agent-events.ts) minus the
 *  discriminator field — the WS frame wraps this in q:event, not as a standalone event. */
export type ToolRequestEventData = Omit<import("../agent-events").ToolRequestEvent, "type">;

// ---- Part Lifecycle Event Payloads ----

/** Payload shape for q:event with event: "part:created".
 *  Pushed by the backend when a new part begins streaming. */
export type PartCreatedEventData = Omit<import("../agent-events").PartCreatedEvent, "type">;

/** Payload shape for q:event with event: "part:delta".
 *  Pushed by the backend for each streaming text token. High-frequency, not persisted. */
export type PartDeltaEventData = Omit<import("../agent-events").PartDeltaEvent, "type">;

/** Payload shape for q:event with event: "part:done".
 *  Pushed by the backend when a part is finalized. Also persisted to DB. */
export type PartDoneEventData = Omit<import("../agent-events").PartDoneEvent, "type">;
