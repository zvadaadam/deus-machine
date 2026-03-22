/**
 * One-time initialization hook for the connection state machine.
 *
 * Call this once in MainLayout (or equivalent top-level component).
 * Subscribes to WS connection changes and send-attempt-failed events,
 * and drives the Zustand store transitions.
 */

import { useEffect } from "react";
import { isConnected, onConnectionChange } from "@/platform/ws";
import { onSendAttemptFailed } from "../lib/connectionEvents";
import { useConnectionStore } from "../store/connectionStore";

export function useConnectionStateInit() {
  useEffect(() => {
    if (isConnected() && useConnectionStore.getState().state !== "connected") {
      useConnectionStore.getState().onConnected();
    }

    const unsubConnection = onConnectionChange((connected) => {
      if (connected) {
        useConnectionStore.getState().onConnected();
      } else {
        useConnectionStore.getState().onDisconnected();
      }
    });

    const unsubSendFailed = onSendAttemptFailed(() => {
      useConnectionStore.getState().markSendAttemptFailed();
    });

    return () => {
      unsubConnection();
      unsubSendFailed();
    };
  }, []);
}
