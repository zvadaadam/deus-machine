/**
 * Connects the WebSocket query protocol client on app mount.
 *
 * All reactive data delivery happens through q:snapshot and q:delta pushed
 * to active WS subscriptions — no separate invalidation bridge is needed.
 *
 * Accepts an optional serverId for relay mode (web-production) where the
 * WS URL includes the server ID in the path.
 */

import { useEffect } from "react";
import { connect } from "@/platform/ws";

export function useQueryProtocol(serverId?: string): void {
  // Connect the WS client once on mount (or when serverId changes)
  useEffect(() => {
    connect(serverId).catch((err) => {
      // Non-fatal: WS is additive. HTTP + IPC events still work.
      if (import.meta.env.DEV) {
        console.warn("[QueryProtocol] WS connection failed:", err);
      }
    });
  }, [serverId]);
}
