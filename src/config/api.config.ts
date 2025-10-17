/**
 * API Configuration
 * Central configuration for API endpoints and settings
 */

export const API_CONFIG = {
  BASE_URL: 'http://localhost:3333/api',
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
