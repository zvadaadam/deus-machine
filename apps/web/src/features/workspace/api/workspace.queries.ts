/**
 * Workspace Query Hooks
 * TanStack Query hooks for workspace-related data fetching
 */

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useMemo } from "react";
import { produce } from "immer";
import { WorkspaceService } from "./workspace.service";
import { RepoService } from "@/features/repository/api/repository.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import type { RepoGroup, DiffStats } from "../types";
import type { PRStatus } from "@/shared/types";
import type { WorkspaceStatus } from "@shared/enums";
import { createOptimisticWorkspace, mergeWorkspaceDelta } from "../lib/workspace.utils";
import { track } from "@/platform/analytics";

/**
 * Fetch workspaces grouped by repository.
 *
 * WS subscription pushes data directly into cache via q:snapshot.
 * HTTP queryFn is fallback for initial load before WS connects.
 * Event-driven invalidation via IPC events also works (both paths coexist).
 */
export function useWorkspacesByRepo(state: string = "ready,initializing") {
  useQuerySubscription("workspaces", {
    queryKey: queryKeys.workspaces.byRepo(state),
    params: { state },
    mergeDelta: mergeWorkspaceDelta,
  });

  return useQuery({
    queryKey: queryKeys.workspaces.byRepo(state),
    queryFn: () => WorkspaceService.fetchByRepo(state),
    staleTime: Infinity, // WS subscription keeps data fresh
    refetchOnWindowFocus: false, // Subscription handles freshness
  });
}

/**
 * Fetch global stats.
 *
 * WS subscription pushes data directly into cache via q:snapshot.
 * HTTP queryFn is fallback for initial load before WS connects.
 */
export function useStats() {
  useQuerySubscription("stats", {
    queryKey: queryKeys.stats.all,
  });

  return useQuery({
    queryKey: queryKeys.stats.all,
    queryFn: () => RepoService.fetchStats(),
    staleTime: Infinity, // WS subscription keeps data fresh
    refetchOnWindowFocus: false, // Subscription handles freshness
  });
}

/**
 * Fetch diff stats for a specific workspace
 * Conditionally polls only when workspace is actively working.
 *
 * When `isWatched` is true (file watcher active via notify crate),
 * polling is disabled — cache invalidation comes from fs:changed events.
 * Falls back to 5s polling when not watched.
 *
 * IMPORTANT: Requires workspaceState === "ready" to avoid fetching diffs
 * against incomplete worktrees during initialization. Running git diff on
 * an initializing worktree produces garbage (e.g. +500K/-1M) that gets
 * cached for 30s, persisting as phantom diffs even after the workspace
 * becomes ready. Guard here, not in the UI.
 */
export function useDiffStats(
  workspaceId: string | null,
  sessionStatus?: string | null,
  isWatched: boolean = false,
  workspaceState?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!),
    enabled: !!workspaceId && workspaceState === "ready",
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
 * - Initial load: fetches ALL ready workspaces in parallel batches of 15
 * - Polling: only re-fetches workspaces with session_status === "working" (5s)
 * - Idle: no polling (staleTime 30s, refetch on window focus)
 * - On workspace list change: seeds from per-workspace cache, fetches only missing/working
 *
 * Guard: state === "ready" — initializing worktrees have incomplete git state
 * (missing HEAD, partial index → garbage diffs like +500K/-1M). Setup script
 * diffs are fine — .gitignore handles them, and `git checkout -- .` in the
 * init pipeline resets any tracked-file mutations from bun install.
 */
export function useBulkDiffStats(repoGroups: RepoGroup[]) {
  const queryClient = useQueryClient();

  // Stable, de-duplicated IDs for query key — only ready workspaces.
  const workspaceIds = useMemo(() => {
    const ids = repoGroups.flatMap((g) =>
      g.workspaces.filter((w) => w.state === "ready").map((w) => w.id)
    );
    return Array.from(new Set(ids)).sort();
  }, [repoGroups]);

  // IDs of workspaces with active sessions — only these need polling.
  const workingIds = useMemo(() => {
    return repoGroups
      .flatMap((g) => g.workspaces)
      .filter((w) => w.state === "ready" && w.session_status === "working")
      .map((w) => w.id);
  }, [repoGroups]);

  const hasWorkingWorkspaces = workingIds.length > 0;

  return useQuery({
    queryKey: ["bulk-diff-stats", workspaceIds],
    enabled: workspaceIds.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval: hasWorkingWorkspaces ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      // Seed from per-workspace cache for workspaces we already have data for
      const results: Record<string, DiffStats> = {};
      for (const id of workspaceIds) {
        const cached = queryClient.getQueryData<DiffStats>(queryKeys.workspaces.diffStats(id));
        if (cached) results[id] = cached;
      }

      // Fetch: missing workspaces + working workspaces (need fresh data)
      const missingIds = workspaceIds.filter((id) => !(id in results));
      const idsToFetch = [...new Set([...missingIds, ...workingIds])];

      if (idsToFetch.length === 0) return results;

      // Parallel batches of 15 — balances throughput vs resource pressure
      const BATCH_SIZE = 15;
      for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
        const batch = idsToFetch.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(
          batch.map((id) => WorkspaceService.fetchDiffStats(id))
        );

        batch.forEach((id, j) => {
          if (settled[j].status === "fulfilled") {
            results[id] = settled[j].value;
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
 *
 * IMPORTANT: Requires workspaceState === "ready" — same guard as useDiffStats.
 * See useDiffStats comment for the full explanation of the phantom diff race.
 */
export function useFileChanges(
  workspaceId: string | null,
  sessionStatus?: string | null,
  isWatched: boolean = false,
  workspaceState?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!);
      return {
        files: result.files || [],
        truncated: result.truncated ?? false,
        totalCount: result.totalCount ?? result.files?.length ?? 0,
      };
    },
    enabled: !!workspaceId && workspaceState === "ready",
    staleTime: 30000,
    // Events handle invalidation when watched; fall back to polling otherwise
    refetchInterval: isWatched ? false : sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch uncommitted files for a workspace (HEAD → workdir).
 * TODO: Backend endpoint not yet implemented — returns empty array.
 */
export function useUncommittedFiles(
  workspaceId: string | null,
  sessionStatus?: string | null,
  workspaceState?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.uncommittedFiles(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchUncommittedFiles(workspaceId!),
    enabled: !!workspaceId && workspaceState === "ready",
    staleTime: 30000,
    refetchInterval: sessionStatus === "working" ? 5000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch last-turn files for a workspace (checkpoint → workdir).
 * TODO: Backend endpoint not yet implemented — returns empty array.
 */
export function useLastTurnFiles(
  workspaceId: string | null,
  sessionId: string | null | undefined,
  sessionStatus?: string | null,
  workspaceState?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.lastTurnFiles(workspaceId || "", sessionId || undefined),
    queryFn: () => WorkspaceService.fetchLastTurnFiles(workspaceId!, sessionId || undefined),
    enabled: !!workspaceId && !!sessionId && workspaceState === "ready",
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
 * Fetch open pull requests for a repository.
 * Used by the "Create Workspace from PR" picker modal.
 * Enabled only when a repoId is provided (i.e., modal is open).
 */
export function useRepoPrs(repoId: string | null) {
  return useQuery({
    queryKey: queryKeys.repos.prs(repoId || ""),
    queryFn: () => WorkspaceService.fetchRepoPrs(repoId!),
    enabled: !!repoId,
    staleTime: 30_000,
  });
}

/**
 * Fetch remote branches for a repository.
 * Used by BranchSelector (welcome screen + Create PR).
 *
 * Currently remote-only (refs/remotes/origin/*). Local-only branches
 * are not included yet — backend endpoint needs to be updated.
 *
 * sendRequest rejects immediately if the WS isn't connected yet (common
 * during app startup and Vite HMR). We retry with exponential backoff
 * so the query self-heals once the WS is ready (~1-2s after load).
 */
export function useRepoBranches(repoId: string | null) {
  return useQuery({
    queryKey: queryKeys.repos.branches(repoId || ""),
    queryFn: () => WorkspaceService.fetchRepoBranches(repoId!),
    enabled: !!repoId,
    staleTime: 30_000,
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });
}

/**
 * Fetch PR status for a workspace.
 *
 * Gated on gh CLI being installed + authenticated.
 * Polls every 30s while agent is working (to detect PR creation),
 * 60s while CI is pending post-session (CI runs 2-15min after push),
 * stops polling otherwise.
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
    refetchInterval: (query) => {
      // While agent is working: poll every 30s to detect PR creation/updates.
      if (sessionStatus === "working") return 30_000;

      // After agent stops: CI checks typically run 2-15min. Poll every 60s
      // while CI is pending so the user sees updates without manual refresh.
      const data = query.state.data as PRStatus | null | undefined;
      if (data?.has_pr && data?.ci_status === "pending") return 60_000;

      // No PR or CI resolved: stop polling. Window focus refetch handles edge cases.
      return false;
    },
    refetchOnWindowFocus: true,
  });
}

/**
 * Fetch specific file diff
 */
export function useFileDiff(workspaceId: string | null, filePath: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFile(workspaceId || "", filePath || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchFileDiff(workspaceId!, filePath!);
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
 * 4. Workspace progress events + terminal invalidation catch the ready transition
 */
/** Params accepted by the create-workspace mutation. */
type CreateWorkspaceParams =
  | string
  | {
      repositoryId: string;
      source_branch?: string;
      pr_number?: number;
      pr_url?: string;
      pr_title?: string;
      target_branch?: string;
    };

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.workspaces.byRepo("ready,initializing");

  return useMutation({
    mutationFn: (params: CreateWorkspaceParams) => {
      const repoId = typeof params === "string" ? params : params.repositoryId;
      const options =
        typeof params === "string"
          ? undefined
          : {
              source_branch: params.source_branch,
              pr_number: params.pr_number,
              pr_url: params.pr_url,
              pr_title: params.pr_title,
              target_branch: params.target_branch,
            };
      return WorkspaceService.create(repoId, options);
    },

    onMutate: async (params: CreateWorkspaceParams) => {
      const repositoryId = typeof params === "string" ? params : params.repositoryId;
      await queryClient.cancelQueries({ queryKey });

      const previousData = queryClient.getQueryData<RepoGroup[]>(queryKey);

      // Inject a placeholder workspace into the matching repo group
      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          const repoGroup = draft.find((g) => g.repo_id === repositoryId);
          if (repoGroup) {
            repoGroup.workspaces.unshift(
              createOptimisticWorkspace(repositoryId, repoGroup.repo_name)
            );
          }
        });
      });

      return { previousData };
    },

    onError: (_err, _params, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKey, context.previousData);
      }
    },

    onSuccess: (_data, params) => {
      const repositoryId = typeof params === "string" ? params : params.repositoryId;
      track("workspace_created", { repository_id: repositoryId });
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
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

    onSuccess: (_data, workspaceId) => {
      track("workspace_archived", { workspace_id: workspaceId });
    },

    // Always refetch after error or success to ensure consistency
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Update workspace workflow status (backlog/in-progress/in-review/done/canceled).
 * Optimistic: updates sidebar immediately, WS subscription confirms.
 */
export function useUpdateWorkspaceStatus() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.workspaces.byRepo("ready,initializing");

  return useMutation({
    mutationFn: ({ workspaceId, status }: { workspaceId: string; status: WorkspaceStatus }) =>
      WorkspaceService.updateStatus(workspaceId, status),

    onMutate: async ({ workspaceId, status }) => {
      await queryClient.cancelQueries({ queryKey });
      let previousStatus: WorkspaceStatus | undefined;

      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          for (const repo of draft) {
            const ws = repo.workspaces.find((w) => w.id === workspaceId);
            if (ws) {
              previousStatus = ws.status;
              ws.status = status;
              break;
            }
          }
        });
      });

      return { workspaceId, previousStatus };
    },

    onError: (_err, _vars, context) => {
      if (context?.previousStatus === undefined) return;
      queryClient.setQueryData<RepoGroup[]>(queryKey, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          for (const repo of draft) {
            const ws = repo.workspaces.find((w) => w.id === context.workspaceId);
            if (ws) {
              ws.status = context.previousStatus!;
              break;
            }
          }
        });
      });
    },

    onSuccess: (_data, { workspaceId, status }) => {
      track("workspace_status_changed", { workspace_id: workspaceId, status });
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Unarchive workspace mutation — restores state to "ready".
 * Used by the undo toast after archiving.
 */
export function useUnarchiveWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => WorkspaceService.update(workspaceId, { state: "ready" }),
    onSuccess: (_data, workspaceId) => {
      track("workspace_unarchived", { workspace_id: workspaceId });
    },
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

/**
 * Fetch deus.json manifest + normalized tasks for a workspace.
 * Manifest doesn't change during a session — staleTime: Infinity.
 */
export function useManifestTasks(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.manifest(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchManifest(workspaceId!),
    enabled: !!workspaceId,
    staleTime: Infinity,
  });
}

/**
 * Retry failed setup for a workspace.
 * Invalidates workspace queries to refresh setup_status.
 */
export function useRetrySetup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => WorkspaceService.retrySetup(workspaceId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}
