import { useState, useEffect, useCallback } from "react";
import { getErrorMessage } from "@shared/lib/errors";
import { getBackendUrl } from "@/shared/config/api.config";

interface BrowserStatus {
  running: boolean;
  port: number | null;
  authToken: string | null;
  error: string | null;
}

/**
 * Hook for managing the dev-browser server.
 * Uses HTTP endpoints on the backend instead of Electron IPC.
 */
export function useBrowser() {
  const [status, setStatus] = useState<BrowserStatus>({
    running: false,
    port: null,
    authToken: null,
    error: null,
  });

  const startServer = useCallback(async () => {
    try {
      const devBrowserPath = import.meta.env.VITE_DEV_BROWSER_PATH || "../../../dev-browser";
      const baseUrl = await getBackendUrl();

      const res = await fetch(`${baseUrl}/api/browser-server/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browserPath: devBrowserPath }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const { port, authToken } = await res.json();
      setStatus({ running: true, port, authToken, error: null });
      return { port, authToken };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error("[useBrowser] Error starting server:", errorMessage);
      setStatus({ running: false, port: null, authToken: null, error: errorMessage });
      throw error;
    }
  }, []);

  const stopServer = useCallback(async () => {
    try {
      const baseUrl = await getBackendUrl();
      const res = await fetch(`${baseUrl}/api/browser-server/stop`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Stop failed: HTTP ${res.status}`);
      }
      setStatus({ running: false, port: null, authToken: null, error: null });
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("[useBrowser] Error stopping server:", msg);
      setStatus((prev) => ({ ...prev, error: msg }));
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const baseUrl = await getBackendUrl();
      const res = await fetch(`${baseUrl}/api/browser-server/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      setStatus({
        running: data.running,
        port: data.port,
        authToken: data.authToken,
        error: null,
      });
    } catch (error) {
      setStatus((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : "Status check failed",
      }));
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  return { status, startServer, stopServer, checkStatus };
}
