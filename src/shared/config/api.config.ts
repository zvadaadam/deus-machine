/**
 * API Configuration
 * Central configuration for API endpoints and settings
 *
 * Supports dynamic port allocation in both Tauri app and web dev mode:
 * - Tauri app: Uses Rust backend manager via invoke('get_backend_port')
 * - Web dev: Uses VITE_BACKEND_PORT environment variable from dev.sh
 * - Port Discovery: Tries to discover backend port by checking /api/health
 * - Fallback: Port 3333 if neither is available
 */

import { invoke } from "@/platform/tauri";

let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

// Common ports to try during discovery (most recently used ports)
// Backend uses PORT=0 for dynamic allocation, so we try a range of common ports
const DISCOVERY_PORTS = [
  51176,
  52820,
  53792, // Recent dynamic ports
  59270,
  59271,
  59269, // Previous attempts
  3333,
  3334,
  3335, // Default fallback range
  8080,
  8081,
  8082, // Alternative common ports
  50000,
  50001,
  50002,
  50003,
  50004,
  50005, // Dynamic port range
  51000,
  51001,
  51002,
  51003,
  51004,
  51005, // More dynamic ports
  52000,
  52001,
  52002,
  52003,
  52004,
  52005, // More dynamic ports
  53000,
  53001,
  53002,
  53003,
  53004,
  53005, // More dynamic ports
];

/**
 * Try to discover backend port by checking /api/health on common ports
 */
async function isBackendHealthResponse(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const data = await response.json();
    return data?.app === "hive-backend" && data?.status === "ok";
  } catch {
    return false;
  }
}

async function discoverBackendPort(): Promise<number | null> {
  // Try localStorage first (fastest)
  const stored = localStorage.getItem("hive_backend_port");
  if (stored) {
    const port = parseInt(stored);
    try {
      const response = await fetch(`http://localhost:${port}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      if (await isBackendHealthResponse(response)) {
        if (import.meta.env.DEV) console.log(`[API] Found backend on stored port: ${port}`);
        return port;
      }
    } catch (e) {
      // Port changed, continue discovery
    }
  }

  // Try discovery on common ports in parallel for speed
  if (import.meta.env.DEV)
    console.log(`[API] Scanning ${DISCOVERY_PORTS.length} ports for backend...`);

  const portChecks = DISCOVERY_PORTS.map(async (port) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 500);

      const response = await fetch(`http://localhost:${port}/api/health`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (await isBackendHealthResponse(response)) {
        return port;
      }
    } catch (e) {
      // Port not available
    }
    return null;
  });

  const results = await Promise.all(portChecks);
  const foundPort = results.find((port) => port !== null);

  if (foundPort) {
    if (import.meta.env.DEV) console.log(`[API] Discovered backend on port: ${foundPort}`);
    localStorage.setItem("hive_backend_port", foundPort.toString());
    return foundPort;
  }

  return null;
}

/**
 * Get the backend port (cached after first call)
 */
async function getBackendPort(): Promise<number> {
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

    // 2. Try Tauri API (for Tauri app mode)
    try {
      const port = await invoke<number>("get_backend_port");
      if (import.meta.env.DEV) console.log(`[API] Using Tauri backend port: ${port}`);
      cachedPort = port;
      return port;
    } catch (error) {
      if (import.meta.env.DEV)
        console.log("[API] Tauri API not available, trying port discovery...");
    }

    // 3. Try port discovery (for web browser accessing Vite dev server)
    const discoveredPort = await discoverBackendPort();
    if (discoveredPort) {
      if (import.meta.env.DEV)
        console.log(`[API] Using discovered backend port: ${discoveredPort}`);
      cachedPort = discoveredPort;
      return discoveredPort;
    }

    // 4. Fallback to hardcoded port
    console.warn("[API] Could not discover backend port, falling back to default port 3333");
    cachedPort = 3333;
    return 3333;
  })();

  // Clear promise when done
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
  POLL_INTERVAL: 2000, // 2 seconds
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

  // Session endpoints
  SESSIONS: "/sessions",
  SESSION_BY_ID: (id: string) => `/sessions/${id}`,
  SESSION_MESSAGES: (id: string) => `/sessions/${id}/messages`,
  SESSION_STOP: (id: string) => `/sessions/${id}/stop`,

  // Repository endpoints
  REPOS: "/repos",
  REPO_BY_ID: (id: string) => `/repos/${id}`,

  // Stats endpoint
  STATS: "/stats",

  // GitHub CLI status
  GH_STATUS: "/gh-status",
} as const;
