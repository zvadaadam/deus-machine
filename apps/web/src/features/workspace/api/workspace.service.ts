/**
 * Workspace Service
 *
 * All data operations go through the Node.js backend via HTTP.
 * The backend handles DB reads, git operations, and file scanning.
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import type { Workspace, RepoGroup, DiffStats, FileChange } from "../types";
import type { PRStatus, GhCliStatus } from "@/shared/types";
import type { NormalizedTask, ManifestResponse, TaskRunResponse } from "@shared/types/manifest";

export type { NormalizedTask, ManifestResponse, TaskRunResponse };

export const WorkspaceService = {
  /**
   * Fetch workspaces grouped by repository.
   */
  fetchByRepo: async (state?: string): Promise<RepoGroup[]> => {
    const query = state ? `?state=${state}` : "";
    return apiClient.get<RepoGroup[]>(`${ENDPOINTS.WORKSPACES_BY_REPO}${query}`);
  },

  /**
   * Fetch diff statistics for a workspace.
   *
   * Diffs are computed against origin/<parent_branch> (remote-first).
   * Workspace creation fetches origin/<parent> before branching the worktree,
   * so the merge-base is always a recent shared commit with upstream.
   */
  fetchDiffStats: async (id: string): Promise<DiffStats> => {
    return apiClient.get<DiffStats>(ENDPOINTS.WORKSPACE_DIFF_STATS(id));
  },

  /**
   * Fetch file changes for a workspace.
   *
   * Returns { files, truncated, totalCount } -- truncated is true when
   * the diff contains more than 1000 files (capped to prevent UI freeze).
   */
  fetchDiffFiles: async (
    id: string
  ): Promise<{ files: FileChange[]; truncated?: boolean; totalCount?: number }> => {
    const result = await apiClient.get<{
      files: FileChange[];
      truncated?: boolean;
      total_count?: number;
    }>(ENDPOINTS.WORKSPACE_DIFF_FILES(id));
    return {
      files: result.files,
      truncated: result.truncated ?? false,
      totalCount: result.total_count ?? result.files.length,
    };
  },

  /**
   * Fetch diff for a specific file.
   */
  fetchFileDiff: async (
    id: string,
    file: string
  ): Promise<{ diff: string; oldContent: string | null; newContent: string | null }> => {
    const data = await apiClient.get<{
      diff: string;
      old_content?: string | null;
      new_content?: string | null;
    }>(ENDPOINTS.WORKSPACE_DIFF_FILE(id, file));
    return {
      diff: data.diff ?? "",
      oldContent: data.old_content ?? null,
      newContent: data.new_content ?? null,
    };
  },

  /**
   * Fetch uncommitted files (HEAD -> workdir diff).
   * TODO: Add backend endpoint for uncommitted files. Currently returns [].
   */
  fetchUncommittedFiles: async (_id: string): Promise<FileChange[]> => {
    return [];
  },

  /**
   * Fetch last-turn files (checkpoint -> workdir diff).
   * TODO: Add backend endpoint for last-turn files. Currently returns [].
   */
  fetchLastTurnFiles: async (_id: string, _sessionId?: string): Promise<FileChange[]> => {
    return [];
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
    return apiClient.patch<Workspace>(ENDPOINTS.WORKSPACE_BY_ID(id), { state: "archived" });
  },

  /**
   * Fetch PR status for a workspace
   */
  fetchPRStatus: async (id: string): Promise<PRStatus | null> => {
    return apiClient.get<PRStatus | null>(ENDPOINTS.WORKSPACE_PR_STATUS(id));
  },

  /**
   * Check GitHub CLI installation and auth status.
   * Cached with long staleTime on the frontend -- rarely changes.
   */
  fetchGhStatus: async (): Promise<GhCliStatus> => {
    return apiClient.get<GhCliStatus>(ENDPOINTS.GH_STATUS);
  },

  /**
   * Fetch system prompt for a workspace
   */
  fetchSystemPrompt: async (id: string): Promise<{ system_prompt: string }> => {
    return apiClient.get<{ system_prompt: string }>(ENDPOINTS.WORKSPACE_SYSTEM_PROMPT(id));
  },

  /**
   * Fetch .pen design files in a workspace
   */
  fetchPenFiles: async (
    id: string
  ): Promise<{ files: Array<{ name: string; path: string }>; count: number }> => {
    return apiClient.get(ENDPOINTS.WORKSPACE_PEN_FILES(id));
  },

  /**
   * Open a .pen file in the Pencil desktop app
   */
  openPenFile: async (id: string, filePath: string): Promise<{ success: boolean }> => {
    return apiClient.post(ENDPOINTS.WORKSPACE_OPEN_PEN_FILE(id), { filePath });
  },

  /**
   * Update system prompt for a workspace
   */
  updateSystemPrompt: async (id: string, systemPrompt: string): Promise<void> => {
    return apiClient.put<void>(ENDPOINTS.WORKSPACE_SYSTEM_PROMPT(id), {
      system_prompt: systemPrompt,
    });
  },

  /**
   * Fetch parsed opendevs.json manifest + normalized tasks for a workspace
   */
  fetchManifest: async (id: string): Promise<ManifestResponse> => {
    return apiClient.get<ManifestResponse>(ENDPOINTS.WORKSPACE_MANIFEST(id));
  },

  /**
   * Retry a failed setup script
   */
  retrySetup: async (id: string): Promise<{ setup_status: string }> => {
    return apiClient.post<{ setup_status: string }>(ENDPOINTS.WORKSPACE_RETRY_SETUP(id), {});
  },

  /**
   * Get setup log output
   */
  fetchSetupLogs: async (id: string): Promise<{ logs: string | null }> => {
    return apiClient.get<{ logs: string | null }>(ENDPOINTS.WORKSPACE_SETUP_LOGS(id));
  },

  /**
   * Run a task -- returns PTY spawn info
   */
  runTask: async (id: string, taskName: string): Promise<TaskRunResponse> => {
    return apiClient.post<TaskRunResponse>(ENDPOINTS.WORKSPACE_TASK_RUN(id, taskName), {});
  },
};
