// WebSocket client hook — subscribes to tool-event + tool-log frames
// from the server and dispatches them into the Zustand stores.

import { useEffect } from "react";
import { useActivityStore } from "../stores/activity-store";
import { useLogsStore } from "../stores/logs-store";

export function useEventsWs(): void {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectDelay = 500;
    let stopped = false;

    function connect() {
      if (stopped) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.addEventListener("open", () => {
        reconnectDelay = 500;
      });
      ws.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
          if (msg.type === "tool-event") {
            useActivityStore.getState().push(msg);
          } else if (msg.type === "tool-log") {
            useLogsStore.getState().append(msg);
          }
        } catch {
          // ignore malformed frames
        }
      });
      ws.addEventListener("close", () => {
        if (stopped) return;
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      });
      ws.addEventListener("error", () => {
        ws?.close();
      });
    }

    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }, []);
}
