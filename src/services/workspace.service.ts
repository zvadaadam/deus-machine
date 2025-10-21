/**
 * Workspace Service
 * API methods for workspace management operations
 */

import { apiClient } from './api';
import { ENDPOINTS } from '../config/api.config';
import type {
  Workspace,
  RepoGroup,
  DiffStats,
  FileChange,
  WorkspaceQueryParams,
  PRStatus,
  DevServer,
} from '../types';

export const WorkspaceService = {
  /**
   * Fetch all workspaces
   */
  fetchAll: async (params?: WorkspaceQueryParams): Promise<Workspace[]> => {
    const queryString = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : '';
    return apiClient.get<Workspace[]>(`${ENDPOINTS.WORKSPACES}${queryString}`);
  },

  /**
   * Fetch workspaces grouped by repository
   */
  fetchByRepo: async (state?: string): Promise<RepoGroup[]> => {
    const query = state ? `?state=${state}` : '';
    return apiClient.get<RepoGroup[]>(`${ENDPOINTS.WORKSPACES_BY_REPO}${query}`);
  },

  /**
   * Fetch single workspace by ID
   */
  fetchById: async (id: string): Promise<Workspace> => {
    return apiClient.get<Workspace>(ENDPOINTS.WORKSPACE_BY_ID(id));
  },

  /**
   * Fetch diff statistics for a workspace
   */
  fetchDiffStats: async (id: string): Promise<DiffStats> => {
    return apiClient.get<DiffStats>(ENDPOINTS.WORKSPACE_DIFF_STATS(id));
  },

  /**
   * Fetch file changes for a workspace
   */
  fetchDiffFiles: async (id: string): Promise<{ files: FileChange[] }> => {
    return apiClient.get<{ files: FileChange[] }>(ENDPOINTS.WORKSPACE_DIFF_FILES(id));
  },

  /**
   * Fetch diff for a specific file
   */
  fetchFileDiff: async (id: string, file: string): Promise<{ diff: string }> => {
    return apiClient.get<{ diff: string }>(ENDPOINTS.WORKSPACE_DIFF_FILE(id, file));
  },

  /**
   * Create a new workspace
   */
  create: async (repositoryId: string): Promise<Workspace> => {
    return apiClient.post<Workspace>(ENDPOINTS.WORKSPACES, { repository_id: repositoryId });
  },

  /**
   * Update workspace (e.g., archive)
   */
  update: async (id: string, data: Partial<Workspace>): Promise<Workspace> => {
    return apiClient.patch<Workspace>(ENDPOINTS.WORKSPACE_BY_ID(id), data);
  },

  /**
   * Archive a workspace
   */
  archive: async (id: string): Promise<Workspace> => {
    return apiClient.patch<Workspace>(ENDPOINTS.WORKSPACE_BY_ID(id), { state: 'archived' });
  },

  /**
   * Fetch PR status for a workspace
   */
  fetchPRStatus: async (id: string): Promise<PRStatus | null> => {
    return apiClient.get<PRStatus | null>(ENDPOINTS.WORKSPACE_PR_STATUS(id));
  },

  /**
   * Fetch dev servers for a workspace
   */
  fetchDevServers: async (id: string): Promise<{ servers: DevServer[] }> => {
    return apiClient.get<{ servers: DevServer[] }>(ENDPOINTS.WORKSPACE_DEV_SERVERS(id));
  },

  /**
   * Fetch system prompt for a workspace
   */
  fetchSystemPrompt: async (id: string): Promise<{ system_prompt: string }> => {
    return apiClient.get<{ system_prompt: string }>(ENDPOINTS.WORKSPACE_SYSTEM_PROMPT(id));
  },

  /**
   * Update system prompt for a workspace
   */
  updateSystemPrompt: async (id: string, systemPrompt: string): Promise<void> => {
    return apiClient.put<void>(ENDPOINTS.WORKSPACE_SYSTEM_PROMPT(id), { system_prompt: systemPrompt });
  },
};
