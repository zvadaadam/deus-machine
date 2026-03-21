/**
 * Connects the WebSocket query protocol client on app mount.
 *
 * All reactive data delivery happens through q:snapshot and q:delta pushed
 * to active WS subscriptions — no separate invalidation bridge is needed.
 *
 * Accepts an optional serverId for relay mode (web-production) where the
 * WS URL includes the server ID in the path.
 */

import { useEffect, useRef } from "react";
import { connect, forceReconnect } from "@/platform/ws";

export function useQueryProtocol(serverId?: string): void {
  // Track the previous serverId so we can detect changes vs initial mount
  const prevServerIdRef = useRef<string | undefined>(serverId);

  // Connect the WS client once on mount (or when serverId changes)
  useEffect(() => {
    // If serverId changed (not initial mount), force the singleton WS client
    // to reconnect so it picks up the new relay endpoint URL.
    if (prevServerIdRef.current !== undefined && prevServerIdRef.current !== serverId) {
      forceReconnect();
    }
    prevServerIdRef.current = serverId;

    connect(serverId).catch((err) => {
      // Non-fatal: WS is additive. HTTP + IPC events still work.
      if (import.meta.env.DEV) {
        console.warn("[QueryProtocol] WS connection failed:", err);
      }
    });

    return () => {
      // On serverId change the effect re-runs — the forceReconnect() above
      // handles reconnection. On final unmount (no new serverId), the WS
      // stays open for potential reuse by other consumers.
    };
  }, [serverId]);
}
