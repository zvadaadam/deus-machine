/**
 * How the app talks to the selected host: `call` an operation from
 * `shared/api`, subscribe through the hooks, listen for events.
 */

export {
  call,
  follow,
  OpError,
  connect,
  isConnected,
  setQueryRequestInterceptor,
  setToolResponseInterceptor,
  sendToolResponse,
  forceReconnect,
  onConnectionChange,
  getRuntimeClient,
  onRuntimeChange,
  runtimeForQueryClient,
  selectRuntime,
} from "./query-protocol-client";
export type { QueryRequestInterceptor, ToolResponseInterceptor } from "./query-protocol-client";
