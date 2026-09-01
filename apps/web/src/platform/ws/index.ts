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
  sendMutate,
  sendToolResponse,
  forceReconnect,
  onEvent,
  onConnectionChange,
} from "./query-protocol-client";
export type { QueryRequestInterceptor } from "./query-protocol-client";
