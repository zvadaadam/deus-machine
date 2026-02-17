/**
 * Workspace Query Hooks
 * TanStack Query hooks for workspace-related data fetching
 */

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import { produce } from "immer";
import { WorkspaceService, type WorkspaceGitInfo } from "./workspace.service";
import { RepoService } from "@/features/repository/api/repository.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { API_CONFIG } from "@/shared/config/api.config";
import type { Workspace, RepoGroup, DiffStats } from "../types";

/**
 * Fetch workspaces grouped by repository with polling.
 * Includes "initializing" workspaces so new ones appear immediately in the sidebar.
 * Polls faster (2s) when any workspace is initializing to catch the ready transition.
 */
export function useWorkspacesByRepo(state: string = "ready,initializing") {
  return useQuery({
    queryKey: queryKeys.workspaces.byRepo(state),
    queryFn: () => WorkspaceService.fetchByRepo(state),
    refetchInterval: (query) => {
      const data = query.state.data as RepoGroup[] | undefined;
      const hasInitializing = data?.some((g) =>
        g.workspaces.some((w) => w.state === "initializing")
      );
      return hasInitializing ? 2_000 : 10_000;
    },
    staleTime: 5000,
  });
}

/**
 * Fetch global stats with polling
 * Stats counters change slowly — no need for real-time accuracy
 */
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats.all,
    queryFn: () => RepoService.fetchStats(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * Fetch diff stats for a specific workspace
 * Conditionally polls only when workspace is actively working.
 *
 * When `isWatched` is true (file watcher active via notify crate),
 * polling is disabled — cache invalidation comes from fs:changed events.
 * Falls back to 5s polling when not watched.
 */
export function useDiffStats(
  workspaceId: string | null,
  sessionStatus?: string | null,
  workspace?: WorkspaceGitInfo,
  isWatched: boolean = false
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!, workspace),
    enabled: !!workspaceId,
    staleTime: 30000,
    // Events handle invalidation when watched; fall back to polling otherwise
    refetchInterval: isWatched ? false : sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch diff stats for all sidebar workspaces in bulk.
 *
 * Replaces per-item useDiffStats() in the sidebar (N hooks → 1 query).
 * - Initial load: fetches ALL workspaces in parallel batches of 15
 * - Polling: only re-fetches workspaces with session_status === "working" (5s)
 * - Idle: no polling (staleTime 30s, refetch on window focus)
 * - On workspace list change: seeds from per-workspace cache, fetches only missing/working
 */
export function useBulkDiffStats(repoGroups: RepoGroup[]) {
  const queryClient = useQueryClient();

  // Build workspace info map for Tauri fast path (5-20ms IPC vs 50-200ms HTTP)
  const workspaceInfoMap = useMemo(() => {
    const map = new Map<string, WorkspaceGitInfo>();
    repoGroups.forEach((g) => {
      g.workspaces.forEach((w) => {
        map.set(w.id, {
          root_path: w.root_path,
          directory_name: w.directory_name,
          workspace_path: w.workspace_path,
          parent_branch: w.parent_branch ?? undefined,
          default_branch: w.default_branch,
        });
      });
    });
    return map;
  }, [repoGroups]);

  // Stable, de-duplicated IDs for query key
  const workspaceIds = useMemo(() => {
    const ids = repoGroups.flatMap((g) => g.workspaces.map((w) => w.id));
    return Array.from(new Set(ids)).sort();
  }, [repoGroups]);

  // IDs of workspaces with active sessions — only these need polling
  const workingIds = useMemo(() => {
    return repoGroups
      .flatMap((g) => g.workspaces)
      .filter((w) => w.session_status === "working")
      .map((w) => w.id);
  }, [repoGroups]);

  const hasWorkingWorkspaces = workingIds.length > 0;

  return useQuery({
    queryKey: ["bulk-diff-stats", workspaceIds],
    enabled: workspaceIds.length > 0,
    staleTime: 30_000,
    // Preserve previous data when workspaceIds change (avoids undefined flash)
    placeholderData: keepPreviousData,
    // Poll only when workspaces are actively working (Claude editing files)
    refetchInterval: hasWorkingWorkspaces ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      // Seed from per-workspace cache (survives query key changes)
      const results: Record<string, DiffStats> = {};
      for (const id of workspaceIds) {
        const cached = queryClient.getQueryData<DiffStats>(queryKeys.workspaces.diffStats(id));
        if (cached) results[id] = cached;
      }

      // Fetch: missing workspaces + working workspaces (need fresh data)
      const missingIds = workspaceIds.filter((id) => !(id in results));
      const idsToFetch = [...new Set([...missingIds, ...workingIds])];

      if (idsToFetch.length === 0) {
        return results;
      }

      // Parallel batches of 15 — balances throughput vs resource pressure
      const BATCH_SIZE = 15;
      for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
        const batch = idsToFetch.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(
          batch.map((id) => WorkspaceService.fetchDiffStats(id, workspaceInfoMap.get(id)))
        );

        batch.forEach((id, j) => {
          if (settled[j].status === "fulfilled") {
            results[id] = settled[j].value;
            // Update per-workspace cache (for detail panel useDiffStats consumers)
            queryClient.setQueryData(queryKeys.workspaces.diffStats(id), settled[j].value);
          }
        });
      }

      return results;
    },
  });
}

/**
 * Fetch file changes for a workspace
 * Conditionally polls only when workspace is actively working.
 *
 * When `isWatched` is true (file watcher active via notify crate),
 * polling is disabled — cache invalidation comes from fs:changed events.
 * Falls back to 5s polling when not watched.
 */
export function useFileChanges(
  workspaceId: string | null,
  sessionStatus?: string | null,
  workspace?: WorkspaceGitInfo,
  isWatched: boolean = false
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!, workspace);
      return {
        files: result.files || [],
        truncated: result.truncated ?? false,
        totalCount: result.totalCount ?? result.files?.length ?? 0,
      };
    },
    enabled: !!workspaceId,
    staleTime: 30000,
    // Events handle invalidation when watched; fall back to polling otherwise
    refetchInterval: isWatched ? false : sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch uncommitted files for a workspace (HEAD → workdir).
 * Tauri IPC only — polls when workspace is actively working.
 */
export function useUncommittedFiles(
  workspaceId: string | null,
  sessionStatus?: string | null,
  workspace?: WorkspaceGitInfo
) {
  return useQuery({
    queryKey: queryKeys.workspaces.uncommittedFiles(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchUncommittedFiles(workspace),
    enabled: !!workspaceId,
    staleTime: 30000,
    refetchInterval: sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch last-turn files for a workspace (checkpoint → workdir).
 * Tauri IPC only — polls when workspace is actively working.
 */
export function useLastTurnFiles(
  workspaceId: string | null,
  sessionId: string | null | undefined,
  sessionStatus?: string | null,
  workspace?: WorkspaceGitInfo
) {
  return useQuery({
    queryKey: queryKeys.workspaces.lastTurnFiles(workspaceId || "", sessionId || undefined),
    queryFn: () => WorkspaceService.fetchLastTurnFiles(workspace, sessionId || undefined),
    enabled: !!workspaceId && !!sessionId,
    staleTime: 30000,
    refetchInterval: sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Check GitHub CLI availability and auth status.
 * Cached with 5-minute staleTime — rarely changes during a session.
 * Gates usePRStatus to avoid wasted gh calls when CLI is missing or unauthenticated.
 */
export function useGhStatus() {
  return useQuery({
    queryKey: queryKeys.github.ghStatus,
    queryFn: () => WorkspaceService.fetchGhStatus(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}

/**
 * Fetch PR status for a workspace.
 *
 * Gated on gh CLI being installed + authenticated (like Codex).
 * Polls every 30s while agent is working (to detect PR creation),
 * stops polling when idle. Auto-refetched on session completion
 * via useSessionEvents invalidation.
 */
export function usePRStatus(
  workspaceId: string | null,
  options?: { ghInstalled?: boolean; ghAuthenticated?: boolean; sessionStatus?: string }
) {
  const { ghInstalled = true, ghAuthenticated = true, sessionStatus } = options ?? {};
  return useQuery({
    queryKey: queryKeys.workspaces.prStatus(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchPRStatus(workspaceId!),
    enabled: !!workspaceId && ghInstalled && ghAuthenticated,
    staleTime: 10_000,
    // Poll while agent is working so we detect PR creation without manual refresh.
    // 30s aligns with CLAUDE.md polling budget; event-driven invalidation via
    // useSessionEvents handles the fast path (agent just created/updated a PR).
    refetchInterval: sessionStatus === "working" ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch specific file diff
 */
export function useFileDiff(
  workspaceId: string | null,
  filePath: string | null,
  workspace?: WorkspaceGitInfo
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFile(workspaceId || "", filePath || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchFileDiff(workspaceId!, filePath!, workspace);
      return result;
    },
    enabled: !!workspaceId && !!filePath,
    staleTime: 10000, // Cache for 10s since diffs are expensive
  });
}

/**
 * Create workspace mutation with optimistic update.
 *
 * Flow:
 * 1. User clicks "+" → placeholder workspace appears instantly in sidebar
 * 2. Backend creates workspace (state = "initializing"), returns it
 * 3. onSuccess replaces placeholder with real data, triggers refetch
 * 4. Polling (2s during init) catches the "ready" transition
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.workspaces.byRepo("ready,initializing");

  return useMutation({
    mutationFn: (repositoryId: string) => WorkspaceService.create(repositoryId),

    onMutate: async (repositoryId: string) => {
      await queryClient.cancelQueries({ queryKey });

      const previousData = queryClient.getQueryData<RepoGroup[]>(queryKey);

      // Inject a placeholder workspace into the matching repo group
      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          const repoGroup = draft.find((g) => g.repo_id === repositoryId);
          if (repoGroup) {
            repoGroup.workspaces.unshift({
              id: `optimistic-${Date.now()}`,
              repository_id: repositoryId,
              directory_name: "",
              display_name: null,
              branch: null,
              parent_branch: null,
              state: "initializing",
              active_session_id: null,
              session_status: null,
              model: null,
              latest_message_sent_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              repo_name: repoGroup.repo_name,
              root_path: "",
              workspace_path: "",
            } satisfies Workspace);
          }
        });
      });

      return { previousData };
    },

    onError: (_err, _repositoryId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKey, context.previousData);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Fetch available branches for a workspace/repo.
 * Uses Tauri IPC (fast, libgit2). Returns [] gracefully in browser/Storybook.
 */
export function useBranches(workspacePath: string | null) {
  return useQuery({
    queryKey: ["branches", workspacePath],
    queryFn: async () => {
      const { isTauriAvailable } = await import("@/platform/tauri/invoke");
      if (!isTauriAvailable()) {
        return [];
      }
      const { gitListBranches } = await import("@/platform/tauri/git");
      return await gitListBranches(workspacePath!);
    },
    enabled: !!workspacePath,
    staleTime: 30_000,
  });
}

/**
 * Archive workspace mutation with optimistic update
 *
 * Flow:
 * 1. User clicks archive → UI updates IMMEDIATELY (workspace removed from list)
 * 2. HTTP request sent in background
 * 3. Success: Cache already correct, refetch confirms
 * 4. Error: Rollback to previous state, show error
 */
export function useArchiveWorkspace() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.workspaces.byRepo("ready,initializing");

  return useMutation({
    mutationFn: (workspaceId: string) => WorkspaceService.archive(workspaceId),

    // Optimistic update: Remove workspace from UI immediately
    onMutate: async (workspaceId: string) => {
      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries({ queryKey });

      // Snapshot the previous value
      const previousData = queryClient.getQueryData<RepoGroup[]>(queryKey);

      // Optimistically remove the workspace from the list
      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          for (const repo of draft) {
            const index = repo.workspaces.findIndex((w) => w.id === workspaceId);
            if (index !== -1) {
              repo.workspaces.splice(index, 1);
              break;
            }
          }
          // Remove empty repos
          return draft.filter((repo) => repo.workspaces.length > 0);
        });
      });

      // Return context with the previous value for rollback
      return { previousData };
    },

    // If mutation fails, roll back to the previous value
    onError: (_err, _workspaceId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKey, context.previousData);
      }
    },

    // Always refetch after error or success to ensure consistency
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Fetch system prompt for a workspace
 */
export function useSystemPrompt(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.systemPrompt(workspaceId || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchSystemPrompt(workspaceId!);
      return result.system_prompt || "";
    },
    enabled: !!workspaceId,
    staleTime: 30000, // System prompts don't change often
  });
}

/**
 * Update system prompt mutation with optimistic update
 */
export function useUpdateSystemPrompt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workspaceId, systemPrompt }: { workspaceId: string; systemPrompt: string }) =>
      WorkspaceService.updateSystemPrompt(workspaceId, systemPrompt),

    // Optimistic update: Show new prompt immediately
    onMutate: async ({ workspaceId, systemPrompt }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.workspaces.systemPrompt(workspaceId),
      });

      const previousPrompt = queryClient.getQueryData<string>(
        queryKeys.workspaces.systemPrompt(workspaceId)
      );

      queryClient.setQueryData(queryKeys.workspaces.systemPrompt(workspaceId), systemPrompt);

      return { previousPrompt };
    },

    onError: (_err, variables, context) => {
      if (context?.previousPrompt !== undefined) {
        queryClient.setQueryData(
          queryKeys.workspaces.systemPrompt(variables.workspaceId),
          context.previousPrompt
        );
      }
    },

    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.systemPrompt(variables.workspaceId),
      });
    },
  });
}
