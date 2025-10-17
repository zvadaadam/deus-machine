/**
 * API Configuration
 * Central configuration for API endpoints and settings
 *
 * Supports dynamic port allocation in both Tauri app and web dev mode:
 * - Tauri app: Uses Rust backend manager via invoke('get_backend_port')
 * - Web dev: Uses VITE_BACKEND_PORT environment variable from dev.sh
 * - Fallback: Port 3333 if neither is available
 */

import { invoke } from '@tauri-apps/api/core';

let cachedPort: number | null = null;
let portPromise: Promise<number> | null = null;

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
        console.log(`[API] Using web dev backend port: ${port}`);
        cachedPort = port;
        return port;
      }
    }

    // 2. Try Tauri API (for Tauri app mode)
    try {
      const port = await invoke<number>('get_backend_port');
      console.log(`[API] Using Tauri backend port: ${port}`);
      cachedPort = port;
      return port;
    } catch (error) {
      console.error('[API] Failed to get backend port from Tauri:', error);
    }

    // 3. Fallback to hardcoded port
    console.warn('[API] Falling back to default port 3333');
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
  WORKSPACES: '/workspaces',
  WORKSPACES_BY_REPO: '/workspaces/by-repo',
  WORKSPACE_BY_ID: (id: string) => `/workspaces/${id}`,
  WORKSPACE_DIFF_STATS: (id: string) => `/workspaces/${id}/diff-stats`,
  WORKSPACE_DIFF_FILES: (id: string) => `/workspaces/${id}/diff-files`,
  WORKSPACE_DIFF_FILE: (id: string, file: string) =>
    `/workspaces/${id}/diff-file?file=${encodeURIComponent(file)}`,

  // Session endpoints
  SESSIONS: '/sessions',
  SESSION_BY_ID: (id: string) => `/sessions/${id}`,
  SESSION_MESSAGES: (id: string) => `/sessions/${id}/messages`,
  SESSION_STOP: (id: string) => `/sessions/${id}/stop`,

  // Repository endpoints
  REPOS: '/repos',
  REPO_BY_ID: (id: string) => `/repos/${id}`,

  // Stats endpoint
  STATS: '/stats',
} as const;
