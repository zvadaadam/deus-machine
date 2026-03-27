/**
 * Workspace Service
 *
 * All data operations go through the WebSocket q:* protocol.
 * Request-only reads use sendRequest, mutations use sendMutate,
 * async actions use sendCommand.
 */

import { sendRequest, sendMutate, sendCommand } from "@/platform/ws";
import type { Workspace, RepoGroup, DiffStats, FileChange } from "../types";
import type { WorkspaceStatus } from "@shared/enums";
import type { PRStatus, GhCliStatus, PRSummary, BranchSummary } from "@/shared/types";
import type { NormalizedTask, ManifestResponse, TaskRunResponse } from "@shared/types/manifest";

export type { NormalizedTask, ManifestResponse, TaskRunResponse };

export const WorkspaceService = {
  /**
   * Fetch workspaces grouped by repository.
   * Note: this is typically received via q:subscribe "workspaces" for real-time push.
   * This one-shot version is used as a fallback.
   */
  fetchByRepo: async (state?: string): Promise<RepoGroup[]> => {
    return sendRequest<RepoGroup[]>("workspaces", state ? { state } : undefined);
  },

  /**
   * Fetch diff statistics for a workspace.
   *
   * Diffs are computed against origin/<parent_branch> (remote-first).
   * Workspace creation fetches origin/<parent> before branching the worktree,
   * so the merge-base is always a recent shared commit with upstream.
   */
  fetchDiffStats: async (id: string): Promise<DiffStats> => {
    return sendRequest<DiffStats>("diffStats", { workspaceId: id });
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
    const result = await sendRequest<{
      files: FileChange[];
      truncated?: boolean;
      total_count?: number;
    }>("diffFiles", { workspaceId: id });
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
    const data = await sendRequest<{
      diff: string;
      old_content?: string | null;
      new_content?: string | null;
    }>("diffFile", { workspaceId: id, file });
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
   * Create a new workspace.
   * Optionally accepts source_branch / PR metadata to create from a
   * specific branch or pull request instead of the repo default branch.
   */
  create: async (
    repositoryId: string,
    options?: {
      source_branch?: string;
      pr_number?: number;
      pr_url?: string;
      pr_title?: string;
      target_branch?: string;
    }
  ): Promise<Pick<Workspace, "id" | "repository_id">> => {
    const result = await sendCommand("createWorkspace", {
      repository_id: repositoryId,
      ...options,
    });
    if (!result.accepted || !result.commandId)
      throw new Error(result.error || "Failed to create workspace");
    // Command ack returns workspace ID as commandId — full workspace data
    // arrives via WS subscription after the backend processes the command.
    return { id: result.commandId, repository_id: repositoryId };
  },

  /**
   * Update workspace (e.g., archive)
   */
  update: async (id: string, data: Partial<Workspace>): Promise<Workspace> => {
    const result = await sendMutate<Workspace>("updateWorkspace", { workspaceId: id, ...data });
    if (!result.success) throw new Error(result.error || "Failed to update workspace");
    return result.data!;
  },

  /**
   * Archive a workspace
   */
  archive: async (id: string): Promise<void> => {
    const result = await sendMutate("archiveWorkspace", { workspaceId: id });
    if (!result.success) throw new Error(result.error || "Failed to archive workspace");
  },

  /**
   * Update workspace workflow status (backlog/in-progress/in-review/done/canceled)
   */
  updateStatus: async (id: string, status: WorkspaceStatus): Promise<void> => {
    const result = await sendMutate("updateWorkspaceStatus", { workspaceId: id, status });
    if (!result.success) throw new Error(result.error || "Failed to update workspace status");
  },

  /**
   * Fetch PR status for a workspace
   */
  fetchPRStatus: async (id: string): Promise<PRStatus | null> => {
    return sendRequest<PRStatus | null>("prStatus", { workspaceId: id });
  },

  /**
   * Check GitHub CLI installation and auth status.
   * Cached with long staleTime on the frontend -- rarely changes.
   */
  fetchGhStatus: async (): Promise<GhCliStatus> => {
    return sendRequest<GhCliStatus>("ghStatus");
  },

  /**
   * Fetch system prompt for a workspace
   */
  fetchSystemPrompt: async (id: string): Promise<{ system_prompt: string }> => {
    return sendRequest<{ system_prompt: string }>("workspace", { workspaceId: id });
  },

  /**
   * Fetch .pen design files in a workspace
   */
  fetchPenFiles: async (
    id: string
  ): Promise<{ files: Array<{ name: string; path: string }>; count: number }> => {
    return sendRequest("penFiles", { workspaceId: id });
  },

  /**
   * Open a .pen file in the Pencil desktop app
   */
  openPenFile: async (id: string, filePath: string): Promise<{ success: boolean }> => {
    const result = await sendCommand("openPenFile", { workspaceId: id, filePath });
    return { success: result.accepted };
  },

  /**
   * Update system prompt for a workspace
   */
  updateSystemPrompt: async (id: string, systemPrompt: string): Promise<void> => {
    const result = await sendMutate("updateWorkspace", {
      workspaceId: id,
      system_prompt: systemPrompt,
    });
    if (!result.success) throw new Error(result.error || "Failed to update system prompt");
  },

  /**
   * Fetch parsed deus.json manifest + normalized tasks for a workspace
   */
  fetchManifest: async (id: string): Promise<ManifestResponse> => {
    return sendRequest<ManifestResponse>("workspaceManifest", { workspaceId: id });
  },

  /**
   * Retry a failed setup script
   */
  retrySetup: async (id: string): Promise<{ setup_status: string }> => {
    const result = await sendCommand("retrySetup", { workspaceId: id });
    if (!result.accepted) throw new Error(result.error || "Failed to retry setup");
    return { setup_status: "running" };
  },

  /**
   * Get setup log output
   */
  fetchSetupLogs: async (id: string): Promise<{ logs: string | null }> => {
    return sendRequest<{ logs: string | null }>("setupLogs", { workspaceId: id });
  },

  /**
   * Run a task -- returns PTY spawn info
   */
  runTask: async (id: string, taskName: string): Promise<TaskRunResponse> => {
    const result = await sendMutate<TaskRunResponse>("runTask", { workspaceId: id, taskName });
    if (!result.success) throw new Error(result.error || "Failed to run task");
    return result.data!;
  },

  /**
   * Fetch open pull requests for a repository.
   * Uses gh CLI on the backend — requires gh to be installed and authenticated.
   */
  fetchRepoPrs: async (repoId: string): Promise<PRSummary[]> => {
    return sendRequest<PRSummary[]>("repoPrs", { repoId });
  },

  /**
   * Fetch remote branches for a repository (sorted by most recent commit).
   * Pure git — no gh CLI needed.
   */
  fetchRepoBranches: async (repoId: string): Promise<{ branches: BranchSummary[] }> => {
    return sendRequest<{ branches: BranchSummary[] }>("repoBranches", { repoId });
  },
};
