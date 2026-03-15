/**
 * WebSocket Platform API
 * Public exports for the WebSocket query protocol client.
 */

export {
  connect,
  subscribe,
  isConnected,
  sendCommand,
  onEvent,
  onConnectionChange,
} from "./query-protocol-client";
