import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DevBrowserStatus {
  running: boolean;
  port: number | null;
  authToken: string | null;
  error: string | null;
}

export function useDevBrowser() {
  const [status, setStatus] = useState<DevBrowserStatus>({
    running: false,
    port: null,
    authToken: null,
    error: null,
  });

  // Start dev-browser server
  const startServer = useCallback(async () => {
    try {
      const devBrowserPath = "/Users/zvada/Documents/BOX/dev-browser";

      await invoke("start_browser_server", {
        browserPath: devBrowserPath,
      });

      // Wait a bit for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get port and auth token
      const port = await invoke<number>("get_browser_port");
      const authToken = await invoke<string>("get_browser_auth_token");

      setStatus({
        running: true,
        port,
        authToken,
        error: null,
      });

      return { port, authToken };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to start dev-browser";
      setStatus({
        running: false,
        port: null,
        authToken: null,
        error: errorMessage,
      });
      throw error;
    }
  }, []);

  // Stop dev-browser server
  const stopServer = useCallback(async () => {
    try {
      await invoke("stop_browser_server");
      setStatus({
        running: false,
        port: null,
        authToken: null,
        error: null,
      });
    } catch (error) {
      console.error("Failed to stop dev-browser:", error);
    }
  }, []);

  // Check if server is running
  const checkStatus = useCallback(async () => {
    try {
      const running = await invoke<boolean>("is_browser_running");

      if (running) {
        const port = await invoke<number>("get_browser_port");
        const authToken = await invoke<string>("get_browser_auth_token");

        setStatus({
          running: true,
          port,
          authToken,
          error: null,
        });
      } else {
        setStatus({
          running: false,
          port: null,
          authToken: null,
          error: null,
        });
      }
    } catch (error) {
      setStatus(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : "Status check failed",
      }));
    }
  }, []);

  // Auto-start on mount
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  return {
    status,
    startServer,
    stopServer,
    checkStatus,
  };
}
