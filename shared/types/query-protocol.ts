// Deus Query protocol types — typed reactive query frames over WebSocket.
// Must match the client contract in devs-web packages/types/src/query-protocol.ts.
// All frame types prefixed with "q:" so they route cleanly in the ws.service dispatcher.

// ---- Resource Definitions ----

/** Queryable resources — must match the client's ResourceName. */
export type QueryResource = "workspaces" | "stats" | "sessions" | "messages";

// ---- Mutation Definitions ----

export type MutationName = "sendMessage" | "archiveWorkspace" | "updateWorkspaceTitle";

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

/** All frames a client can send. */
export type QClientFrame = QRequestFrame | QSubscribeFrame | QUnsubscribeFrame | QMutateFrame;

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
  | QInvalidateFrame
  | QErrorFrame;
