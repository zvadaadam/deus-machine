/**
 * WebSocket Platform API
 * Public exports for the WebSocket query protocol client.
 */

export {
  call,
  OpError,
  connect,
  isConnected,
  sendCommand,
  sendRequest,
  setQueryRequestInterceptor,
  setToolResponseInterceptor,
  emitLocalEvent,
  sendMutate,
  sendToolResponse,
  forceReconnect,
  onEvent,
  onConnectionChange,
  getRuntimeClient,
  onRuntimeChange,
  runtimeForQueryClient,
  selectRuntime,
} from "./query-protocol-client";
export type { QueryRequestInterceptor, ToolResponseInterceptor } from "./query-protocol-client";
