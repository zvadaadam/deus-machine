/**
 * Workspace Service
 * API methods for workspace management operations
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import { isTauriAvailable } from "@/platform/tauri/invoke";
import { gitDiffStats, gitDiffFiles, gitDiffFile } from "@/platform/tauri/git";
import type { Workspace, RepoGroup, DiffStats, FileChange } from "../types";
import type { WorkspaceQueryParams, PRStatus } from "@/shared/types";

/** Workspace data needed for Tauri git commands (subset of Workspace) */
export interface WorkspaceGitInfo {
  root_path: string;
  directory_name: string;
  parent_branch?: string;
  default_branch?: string;
}

function getWorkspacePath(ws: WorkspaceGitInfo): string {
  return `${ws.root_path}/.conductor/${ws.directory_name}`;
}

export const WorkspaceService = {
  /**
   * Fetch all workspaces
   */
  fetchAll: async (params?: WorkspaceQueryParams): Promise<Workspace[]> => {
    const queryString = params
      ? `?${new URLSearchParams(params as Record<string, string>).toString()}`
      : "";
    return apiClient.get<Workspace[]>(`${ENDPOINTS.WORKSPACES}${queryString}`);
  },

  /**
   * Fetch workspaces grouped by repository
   */
  fetchByRepo: async (state?: string): Promise<RepoGroup[]> => {
    const query = state ? `?state=${state}` : "";
    return apiClient.get<RepoGroup[]>(`${ENDPOINTS.WORKSPACES_BY_REPO}${query}`);
  },

  /**
   * Fetch single workspace by ID
   */
  fetchById: async (id: string): Promise<Workspace> => {
    return apiClient.get<Workspace>(ENDPOINTS.WORKSPACE_BY_ID(id));
  },

  /**
   * Fetch diff statistics for a workspace.
   * Uses Rust/libgit2 via Tauri IPC when available (5-20ms),
   * falls back to Node.js HTTP when in web mode (50-200ms).
   */
  fetchDiffStats: async (id: string, workspace?: WorkspaceGitInfo): Promise<DiffStats> => {
    if (isTauriAvailable() && workspace?.root_path && workspace?.directory_name) {
      return gitDiffStats(
        getWorkspacePath(workspace),
        workspace.parent_branch || "",
        workspace.default_branch || ""
      );
    }
    return apiClient.get<DiffStats>(ENDPOINTS.WORKSPACE_DIFF_STATS(id));
  },

  /**
   * Fetch file changes for a workspace.
   * Uses Rust/libgit2 via Tauri IPC when available,
   * falls back to Node.js HTTP when in web mode.
   */
  fetchDiffFiles: async (
    id: string,
    workspace?: WorkspaceGitInfo
  ): Promise<{ files: FileChange[] }> => {
    if (isTauriAvailable() && workspace?.root_path && workspace?.directory_name) {
      const files = await gitDiffFiles(
        getWorkspacePath(workspace),
        workspace.parent_branch || "",
        workspace.default_branch || ""
      );
      return { files: files as FileChange[] };
    }
    return apiClient.get<{ files: FileChange[] }>(ENDPOINTS.WORKSPACE_DIFF_FILES(id));
  },

  /**
   * Fetch diff for a specific file.
   * Uses Rust/libgit2 via Tauri IPC when available,
   * falls back to Node.js HTTP when in web mode.
   */
  fetchFileDiff: async (
    id: string,
    file: string,
    workspace?: WorkspaceGitInfo
  ): Promise<{ diff: string; oldContent: string | null; newContent: string | null }> => {
    if (isTauriAvailable() && workspace?.root_path && workspace?.directory_name) {
      const data = await gitDiffFile(
        getWorkspacePath(workspace),
        workspace.parent_branch || "",
        workspace.default_branch || "",
        file
      );
      return {
        diff: data.diff ?? "",
        oldContent: data.old_content ?? null,
        newContent: data.new_content ?? null,
      };
    }
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
};
