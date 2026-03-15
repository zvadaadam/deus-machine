/**
 * useSocket Hook (Deprecated)
 *
 * Previously managed the Unix socket connection to the sidecar via Rust IPC.
 * Now a no-op — all agent communication flows through the backend WebSocket.
 * Kept as a stub to avoid breaking imports during transition; will be removed
 * in a follow-up cleanup.
 */
export function useSocket() {
  return {
    isConnected: true,
  };
}
