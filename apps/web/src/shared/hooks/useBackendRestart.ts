/**
 * Backend Restart Hook
 *
 * Listens for the "backend:port-changed" IPC event emitted by the Electron
 * main process after the backend crashes and restarts on a new port.
 *
 * On receiving the event:
 * 1. Updates the cached backend port so all future HTTP requests hit the new port
 * 2. Forces an immediate WebSocket reconnect (cancels backoff, closes stale socket)
 *
 * Without this hook, the renderer would keep retrying the dead old port forever
 * because getBackendPort() caches the port from first resolution.
 */

import { useEffect } from "react";
import { native } from "@/platform";
import { BACKEND_PORT_CHANGED } from "@shared/events";
import { setBackendPort } from "@/shared/config/api.config";
import { forceReconnect } from "@/platform/ws/query-protocol-client";

export function useBackendRestart() {
  useEffect(() => {
    const unlisten = native.events.on(BACKEND_PORT_CHANGED, (data) => {
      const { port } = data;
      console.log(`[BackendRestart] Backend restarted on port ${port}, reconnecting...`);

      // 1. Update the cached port so getBackendPort() returns the new value
      setBackendPort(port);

      // 2. Force immediate WebSocket reconnect to the new port
      forceReconnect();
    });

    return unlisten;
  }, []);
}
