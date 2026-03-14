import { useEffect } from "react";
import { socketService } from "@/platform/socket";

/**
 * Hook to manage socket connection lifecycle
 */
export function useSocket() {
  useEffect(() => {
    socketService.connect().then(
      () => {
        if (import.meta.env.DEV) console.log("[useSocket] Socket connected");
      },
      (error) => {
        console.error("[useSocket] Socket connection failed:", error);
      }
    );
    // No cleanup: socketService is a singleton shared across the app.
    // Disconnecting here would kill the connection for all consumers
    // when any single component using this hook unmounts.
  }, []);

  return {
    isConnected: socketService.isConnected(),
  };
}
