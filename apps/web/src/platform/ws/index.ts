/**
 * WebSocket Platform API
 * Public exports for the WebSocket query protocol client.
 */

export {
  connect,
  subscribe,
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
} from "./query-protocol-client";
export type { QueryRequestInterceptor, ToolResponseInterceptor } from "./query-protocol-client";
