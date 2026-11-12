/** Framework-independent q: client. Cache integration is opt-in via /query. */
export { RuntimeClient } from "./client";
export { subscriptionKey } from "./identity";
export { RuntimeError } from "./types";
export type {
  RuntimeIdentity,
  RuntimeSocket,
  RuntimeState,
  RuntimeFailureKind,
  RuntimePorts,
  QueryRequestInterceptor,
  ToolResponseInterceptor,
  EventCallback,
  SnapshotCallback,
  DeltaCallback,
  StreamCallback,
  ListenOptions,
  MutateResult,
} from "./types";
