import { useEffect } from "react";
import { socketService } from "@/services/socket";

/**
 * Hook to manage socket connection lifecycle
 */
export function useSocket() {
  useEffect(() => {
    let socketConnected = false;

    const connectSocket = async () => {
      try {
        await socketService.connect();
        socketConnected = true;
        console.log('[useSocket] ✅ Socket connected');
      } catch (error) {
        console.error('[useSocket] ❌ Socket connection failed:', error);
        // Fall back to HTTP if socket fails
      }
    };

    connectSocket();

    return () => {
      if (socketConnected) {
        socketService.disconnect();
      }
    };
  }, []);

  return {
    isConnected: socketService.isConnected(),
  };
}
