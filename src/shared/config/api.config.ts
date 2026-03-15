/**
 * API Configuration
 * Central configuration for API endpoints and settings
 *
 * Port resolution:
 * - Tauri app: Uses Rust backend manager via invoke('get_backend_port')
 * - Web dev: Uses VITE_BACKEND_PORT environment variable from dev.sh
 */

import { invoke, isTauriEnv } from "@/platform/tauri";

let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

// Tauri IPC retry config for backend port resolution.
// The backend may not have emitted its [BACKEND_PORT] marker yet during early
// startup — Rust setup() blocks the main thread for up to 5s waiting for it,
// and IPC calls from the webview are queued until setup completes.
// 30 attempts × 200ms = 6s covers the 5s startup timeout with margin.
const TAURI_PORT_MAX_RETRIES = 30;
const TAURI_PORT_RETRY_DELAY_MS = 200;

/**
 * Get the backend port (cached after first call).
 *
 * In Tauri mode, retries the IPC call with backoff because the backend may
 * still be starting when the webview first loads. Without retries, a single
 * failed invoke permanently caches port 3333, causing all API requests to
 * hit the wrong port and leaving the window hidden.
 */
export async function getBackendPort(): Promise<number> {
  if (cachedPort !== null) {
    return cachedPort;
  }

  // If there's already a pending request, return it
  if (portPromise !== null) {
    return portPromise;
  }

  portPromise = (async () => {
    // 1. Check if running in web dev mode with dynamic port
    if (import.meta.env.VITE_BACKEND_PORT) {
      const port = parseInt(import.meta.env.VITE_BACKEND_PORT as string, 10);
      if (!isNaN(port)) {
        if (import.meta.env.DEV) console.log(`[API] Using web dev backend port: ${port}`);
        cachedPort = port;
        return port;
      }
    }

    // 2. Try Tauri API — retry with backoff.
    // The backend is managed by Rust and WILL start, but the port may not
    // be available yet if we're called before setup() finishes.
    if (isTauriEnv) {
      for (let attempt = 0; attempt < TAURI_PORT_MAX_RETRIES; attempt++) {
        try {
          const port = await invoke<number>("get_backend_port");
          if (import.meta.env.DEV)
            console.log(`[API] Using Tauri backend port: ${port} (attempt ${attempt + 1})`);
          cachedPort = port;
          return port;
        } catch {
          if (attempt < TAURI_PORT_MAX_RETRIES - 1) {
            await new Promise((resolve) => setTimeout(resolve, TAURI_PORT_RETRY_DELAY_MS));
          }
        }
      }
      // All retries exhausted — don't cache a wrong port. Throw so TanStack Query
      // retries the entire fetch later, giving the backend more time to start.
      console.error("[API] get_backend_port failed after retries — backend may not have started");
      throw new Error("Backend port not available after retries");
    }

    // 3. Fallback for non-Tauri dev mode without VITE_BACKEND_PORT
    console.warn("[API] No port source available, falling back to default port 3333");
    return 3333;
  })();

  // Clear promise when done (success or failure)
  portPromise.finally(() => {
    portPromise = null;
  });

  return portPromise;
}

/**
 * Get the base URL for API requests (async)
 */
export async function getBaseURL(): Promise<string> {
  const port = await getBackendPort();
  return `http://localhost:${port}/api`;
}

export const API_CONFIG = {
  getBaseURL,
  REQUEST_TIMEOUT: 30000, // 30 seconds
} as const;

export const ENDPOINTS = {
  // Workspace endpoints
  WORKSPACES: "/workspaces",
  WORKSPACES_BY_REPO: "/workspaces/by-repo",
  WORKSPACE_BY_ID: (id: string) => `/workspaces/${id}`,
  WORKSPACE_DIFF_STATS: (id: string) => `/workspaces/${id}/diff-stats`,
  WORKSPACE_DIFF_FILES: (id: string) => `/workspaces/${id}/diff-files`,
  WORKSPACE_DIFF_FILE: (id: string, file: string) =>
    `/workspaces/${id}/diff-file?file=${encodeURIComponent(file)}`,
  WORKSPACE_PR_STATUS: (id: string) => `/workspaces/${id}/pr-status`,
  WORKSPACE_SYSTEM_PROMPT: (id: string) => `/workspaces/${id}/system-prompt`,
  WORKSPACE_PEN_FILES: (id: string) => `/workspaces/${id}/pen-files`,
  WORKSPACE_OPEN_PEN_FILE: (id: string) => `/workspaces/${id}/open-pen-file`,
  WORKSPACE_SESSIONS: (workspaceId: string) => `/workspaces/${workspaceId}/sessions`,
  WORKSPACE_MANIFEST: (id: string) => `/workspaces/${id}/manifest`,
  WORKSPACE_RETRY_SETUP: (id: string) => `/workspaces/${id}/retry-setup`,
  WORKSPACE_SETUP_LOGS: (id: string) => `/workspaces/${id}/setup-logs`,
  WORKSPACE_TASK_RUN: (id: string, taskName: string) =>
    `/workspaces/${id}/tasks/${encodeURIComponent(taskName)}/run`,

  // Session endpoints
  SESSIONS: "/sessions",
  SESSION_BY_ID: (id: string) => `/sessions/${id}`,
  SESSION_MESSAGES: (id: string) => `/sessions/${id}/messages`,
  SESSION_STOP: (id: string) => `/sessions/${id}/stop`,

  // Repository endpoints
  REPOS: "/repos",
  REPO_BY_ID: (id: string) => `/repos/${id}`,
  REPO_MANIFEST: (id: string) => `/repos/${id}/manifest`,
  REPO_DETECT_MANIFEST: (id: string) => `/repos/${id}/detect-manifest`,

  // Stats endpoint
  STATS: "/stats",

  // GitHub CLI status
  GH_STATUS: "/gh-status",
} as const;
