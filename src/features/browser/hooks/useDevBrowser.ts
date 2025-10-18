import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DevBrowserStatus {
  running: boolean;
  port: number | null;
  authToken: string | null;
  error: string | null;
}

// Check if we're running in Tauri or web mode
const isTauriMode = () => {
  try {
    const w = window as any;
    return !!(w && (w.__TAURI__ || w.__TAURI_IPC__));
  } catch {
    return false;
  }
};

export function useDevBrowser() {
  const [status, setStatus] = useState<DevBrowserStatus>({
    running: false,
    port: null,
    authToken: null,
    error: null,
  });

  // Start dev-browser server (Tauri mode) or check for existing server (Web mode)
  const startServer = useCallback(async () => {
    try {
      if (isTauriMode()) {
        // Tauri mode: start server via Rust backend
        // Use environment variable if available, otherwise use relative path
        const devBrowserPath = import.meta.env.VITE_DEV_BROWSER_PATH ||
          "../../../dev-browser";

        await invoke("start_browser_server", {
          browserPath: devBrowserPath,
        });

        // Wait a bit for server to start
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Get port and auth token
        const port = await invoke<number | null>("get_browser_port");
        const authToken = await invoke<string | null>("get_browser_auth_token");

        setStatus({
          running: true,
          port,
          authToken,
          error: null,
        });

        return { port, authToken };
      } else {
        // Web mode: check for existing MCP server on port 3000
        const response = await fetch('http://localhost:3000/health');
        if (response.ok) {
          await response.json(); // Response checked; details unused

          setStatus({
            running: true,
            port: 3000,
            authToken: null, // Auth token not needed for pre-authorized mode
            error: null,
          });

          return { port: 3000, authToken: null };
        } else {
          throw new Error('MCP server not responding');
        }
      }
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
      if (isTauriMode()) {
        await invoke("stop_browser_server");
      }
      // In web mode, we don't stop the server (it's external)
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
      if (isTauriMode()) {
        // Tauri mode: check via Rust backend
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
      } else {
        // Web mode: check for existing MCP server
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          let response: Response;
          try {
            response = await fetch('http://localhost:3000/health', { signal: controller.signal });
          } finally {
            clearTimeout(timeoutId);
          }
          if (response.ok) {
            setStatus({
              running: true,
              port: 3000,
              authToken: null,
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
        } catch (e) {
          setStatus({
            running: false,
            port: null,
            authToken: null,
            error: 'MCP server not running on port 3000',
          });
        }
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
