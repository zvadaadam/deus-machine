// Query protocol — WebSocket wire format for the cloud relay.
// All frame types prefixed with "q:" so they route cleanly in the ws.service dispatcher.
//
// Domain constants (QUERY_RESOURCES, MUTATION_NAMES, COMMAND_NAMES, PROTOCOL_EVENTS)
// live in shared/events.ts — the single source of truth for all app events
// and resources. This file only defines the wire format that carries them.

import type { QueryResource, MutationName, CommandName, ProtocolEvent } from "../events";

// Re-export so existing `import { QueryResource } from "query-protocol"` still works.
export type { QueryResource, MutationName, CommandName, ProtocolEvent };
export { QUERY_RESOURCES, MUTATION_NAMES, COMMAND_NAMES, PROTOCOL_EVENTS } from "../events";

// ---- Client → Server Frames ----

/** Client requests data (one-shot). */
export interface QRequestFrame {
  type: "q:request";
  id: string;
  resource: QueryResource;
  params?: Record<string, unknown>;
}

/** Client subscribes to live updates for a resource. */
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
export interface QToolResponseFrame {
  type: "q:tool_response";
  requestId: string;
  result?: unknown;
  error?: string;
}

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
  | QDeltaFrame
  | QMutateResultFrame
  | QCommandAckFrame
  | QEventFrame
  | QInvalidateFrame
  | QErrorFrame;

// ---- Tool Relay Event Payload ----

/** Payload shape for q:event with event: "tool:request".
 *  Sent by the backend when relaying a tool request from the agent to the frontend. */
export interface ToolRequestEventData {
  requestId: string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs: number;
}
