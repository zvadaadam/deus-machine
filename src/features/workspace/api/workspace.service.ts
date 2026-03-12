/**
 * Workspace Service
 * API methods for workspace management operations
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import { isTauriAvailable } from "@/platform/tauri/invoke";
import {
  gitDiffStats,
  gitDiffFiles,
  gitDiffFile,
  gitUncommittedFiles,
  gitLastTurnFiles,
} from "@/platform/tauri/git";
import { dbGetWorkspacesByRepo } from "@/platform/tauri/db";
import type { Workspace, RepoGroup, DiffStats, FileChange } from "../types";
import type { WorkspaceQueryParams, PRStatus, GhCliStatus } from "@/shared/types";

/** Normalized task from opendevs.json manifest */
export interface NormalizedTask {
  name: string;
  command: string;
  description: string | null;
  icon: string;
  persistent: boolean;
  mode: "concurrent" | "nonconcurrent";
  depends: string[];
  env: Record<string, string>;
}

/** Response from GET /workspaces/:id/manifest */
export interface ManifestResponse {
  manifest: Record<string, unknown> | null;
  tasks: NormalizedTask[];
}

/** Response from POST /workspaces/:id/tasks/:name/run */
export interface TaskRunResponse {
  ptyId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  persistent: boolean;
  mode: "concurrent" | "nonconcurrent";
}

/** Workspace data needed for Tauri git commands (subset of Workspace) */
export interface WorkspaceGitInfo {
  root_path: string;
  slug: string;
  workspace_path?: string;
  git_target_branch?: string;
  git_default_branch?: string;
}

function getWorkspacePath(ws: WorkspaceGitInfo): string {
  if (ws.workspace_path) return ws.workspace_path;
  return `${ws.root_path}/.opendevs/${ws.slug}`;
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
   * Fetch workspaces grouped by repository.
   * Uses Rust/rusqlite via Tauri IPC when available (~1ms),
   * falls back to Node.js HTTP when in web mode (~50-200ms).
   */
  fetchByRepo: async (state?: string): Promise<RepoGroup[]> => {
    if (isTauriAvailable()) {
      try {
        return await dbGetWorkspacesByRepo(state);
      } catch {
        // Rust DB failed — fall through to HTTP
      }
    }
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
   *
   * Diffs are computed against origin/<parent_branch> (remote-first).
   * Workspace creation fetches origin/<parent> before branching the worktree,
   * so the merge-base is always a recent shared commit with upstream.
   * See: src-tauri/src/git.rs::resolve_parent_branch for the resolution logic.
   */
  fetchDiffStats: async (id: string, workspace?: WorkspaceGitInfo): Promise<DiffStats> => {
    if (isTauriAvailable() && workspace?.root_path && workspace?.slug) {
      try {
        return await gitDiffStats(
          getWorkspacePath(workspace),
          workspace.git_target_branch || "",
          workspace.git_default_branch || ""
        );
      } catch {
        // Rust git failed (e.g., worktree deleted) — fall through to HTTP
      }
    }
    return apiClient.get<DiffStats>(ENDPOINTS.WORKSPACE_DIFF_STATS(id));
  },

  /**
   * Fetch file changes for a workspace.
   * Uses Rust/libgit2 via Tauri IPC when available,
   * falls back to Node.js HTTP when in web mode.
   *
   * Returns { files, truncated, totalCount } — truncated is true when
   * the diff contains more than 1000 files (capped to prevent UI freeze).
   */
  fetchDiffFiles: async (
    id: string,
    workspace?: WorkspaceGitInfo
  ): Promise<{ files: FileChange[]; truncated?: boolean; totalCount?: number }> => {
    if (isTauriAvailable() && workspace?.root_path && workspace?.slug) {
      try {
        const result = await gitDiffFiles(
          getWorkspacePath(workspace),
          workspace.git_target_branch || "",
          workspace.git_default_branch || ""
        );
        return {
          files: result.files,
          truncated: result.truncated,
          totalCount: result.total_count,
        };
      } catch {
        // Rust git failed — fall through to HTTP
      }
    }
    const result = await apiClient.get<{ files: FileChange[]; truncated?: boolean; total_count?: number }>(
      ENDPOINTS.WORKSPACE_DIFF_FILES(id)
    );
    return {
      files: result.files,
      truncated: result.truncated ?? false,
      totalCount: result.total_count ?? result.files.length,
    };
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
    if (isTauriAvailable() && workspace?.root_path && workspace?.slug) {
      try {
        const data = await gitDiffFile(
          getWorkspacePath(workspace),
          workspace.git_target_branch || "",
          workspace.git_default_branch || "",
          file
        );
        return {
          diff: data.diff ?? "",
          oldContent: data.old_content ?? null,
          newContent: data.new_content ?? null,
        };
      } catch {
        // Rust git failed — fall through to HTTP
      }
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
   * Fetch uncommitted files (HEAD → workdir diff).
   * Tauri IPC only — no HTTP fallback needed.
   */
  fetchUncommittedFiles: async (workspace?: WorkspaceGitInfo): Promise<FileChange[]> => {
    if (!isTauriAvailable() || !workspace?.root_path || !workspace?.slug) {
      return [];
    }
    try {
      const files = await gitUncommittedFiles(getWorkspacePath(workspace));
      return files;
    } catch {
      return [];
    }
  },

  /**
   * Fetch last-turn files (checkpoint → workdir diff).
   * Tauri IPC only — no HTTP fallback needed.
   */
  fetchLastTurnFiles: async (
    workspace?: WorkspaceGitInfo,
    sessionId?: string
  ): Promise<FileChange[]> => {
    if (!isTauriAvailable() || !workspace?.root_path || !workspace?.slug || !sessionId) {
      return [];
    }
    try {
      const files = await gitLastTurnFiles(getWorkspacePath(workspace), sessionId);
      return files;
    } catch {
      // No checkpoints exist yet — expected for new sessions
      return [];
    }
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
   * Cached with long staleTime on the frontend — rarely changes.
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
   * Run a task — returns PTY spawn info
   */
  runTask: async (id: string, taskName: string): Promise<TaskRunResponse> => {
    return apiClient.post<TaskRunResponse>(ENDPOINTS.WORKSPACE_TASK_RUN(id, taskName), {});
  },
};
