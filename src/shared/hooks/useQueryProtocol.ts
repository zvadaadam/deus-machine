/**
 * Connects the WebSocket query protocol client on app mount.
 *
 * All reactive data delivery happens through q:snapshot and q:delta pushed
 * to active WS subscriptions — no separate invalidation bridge is needed.
 */

import { useEffect } from "react";
import { connect } from "@/platform/ws";

export function useQueryProtocol(): void {
  // Connect the WS client once on mount
  useEffect(() => {
    connect().catch((err) => {
      // Non-fatal: WS is additive. HTTP + Tauri events still work.
      if (import.meta.env.DEV) {
        console.warn("[QueryProtocol] WS connection failed:", err);
      }
    });
  }, []);
}
