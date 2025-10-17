/**
 * API Configuration
 * Central configuration for API endpoints and settings
 *
 * Now uses dynamic port allocation via Tauri command
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
    try {
      const port = await invoke<number>('get_backend_port');
      cachedPort = port;
      return port;
    } catch (error) {
      console.error('Failed to get backend port:', error);
      // Fallback to hardcoded port for development
      console.warn('Falling back to default port 3333');
      cachedPort = 3333;
      return 3333;
    } finally {
      portPromise = null;
    }
  })();

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
