/**
 * Workspace Query Hooks
 * TanStack Query hooks for workspace-related data fetching
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { produce } from "immer";
import { WorkspaceService } from "./workspace.service";
import { RepoService } from "@/features/repository/api/repository.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { API_CONFIG } from "@/shared/config/api.config";
import type { RepoGroup, DiffStats, FileChange } from "../types";
import type { PRStatus, DevServer } from "@/shared/types";

/**
 * Fetch workspaces grouped by repository with polling
 */
export function useWorkspacesByRepo(state: string = "ready") {
  return useQuery({
    queryKey: queryKeys.workspaces.byRepo(state),
    queryFn: () => WorkspaceService.fetchByRepo(state),
    refetchInterval: API_CONFIG.POLL_INTERVAL,
    staleTime: 1000,
  });
}

/**
 * Fetch global stats with polling
 */
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats.all,
    queryFn: () => RepoService.fetchStats(),
    refetchInterval: API_CONFIG.POLL_INTERVAL,
    staleTime: 1000,
  });
}

/**
 * Fetch diff stats for a specific workspace
 * Conditionally polls only when workspace is actively working
 *
 * NOTE: Polling is kept even on desktop because:
 * - No events implemented for git diff changes (would require file watching)
 * - Diff stats badges need updates when Claude edits files
 * - Polling only happens when workspace is actively working (96-100% reduction)
 * - Future: Implement file system events to eliminate polling on desktop
 */
export function useDiffStats(workspaceId: string | null, sessionStatus?: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30000, // 30 seconds for idle workspaces
    // ✅ Poll ONLY when workspace is actively working
    // TODO: Disable on desktop once git diff events are implemented
    refetchInterval: sessionStatus === "working" ? 5000 : false,
  });
}

/**
 * Fetch diff stats for multiple workspaces (progressive loading)
 * This replaces the complex progressive loading logic from useDiffStats hook
 */
export function useBulkDiffStats(repoGroups: RepoGroup[]) {
  const queryClient = useQueryClient();

  // Stable, de-duplicated IDs for keying and effects
  const workspaceIds = useMemo(() => {
    const ids = repoGroups.flatMap((g) => g.workspaces.map((w) => w.id));
    return Array.from(new Set(ids)).sort(); // stable order
  }, [repoGroups]);

  // Prime cache for first N and return aggregate
  const query = useQuery({
    queryKey: ["bulk-diff-stats", workspaceIds],
    enabled: workspaceIds.length > 0,
    staleTime: 1000,
    queryFn: async () => {
      const first5 = workspaceIds.slice(0, 5);
      const firstResults = await Promise.all(
        first5.map((id) => WorkspaceService.fetchDiffStats(id))
      );

      // Cache first 5 results immediately
      first5.forEach((id, i) => {
        queryClient.setQueryData(queryKeys.workspaces.diffStats(id), firstResults[i]);
      });

      // Aggregate from cache (includes any previously prefetched items)
      const aggregate: Record<string, DiffStats> = {};
      workspaceIds.forEach((id) => {
        const stats = queryClient.getQueryData<DiffStats>(queryKeys.workspaces.diffStats(id));
        if (stats) aggregate[id] = stats;
      });

      return aggregate;
    },
  });

  // Stagger prefetch for remaining IDs with cleanup
  useEffect(() => {
    if (workspaceIds.length <= 5) return;

    const timers = workspaceIds.slice(5).map((id, idx) => {
      return setTimeout(() => {
        queryClient
          .prefetchQuery({
            queryKey: queryKeys.workspaces.diffStats(id),
            queryFn: () => WorkspaceService.fetchDiffStats(id),
          })
          .then(() => {
            // Update aggregate cache with new data
            const data = queryClient.getQueryData<DiffStats>(queryKeys.workspaces.diffStats(id));
            if (data) {
              const existing =
                queryClient.getQueryData<Record<string, DiffStats>>([
                  "bulk-diff-stats",
                  workspaceIds,
                ]) || {};
              queryClient.setQueryData(["bulk-diff-stats", workspaceIds], {
                ...existing,
                [id]: data,
              });
            }
          });
      }, idx * 200);
    });

    // Cleanup timers on unmount or when workspaceIds change
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [workspaceIds, queryClient]);

  return query;
}

/**
 * Fetch file changes for a workspace
 * Conditionally polls only when workspace is actively working
 *
 * NOTE: Polling is kept even on desktop because:
 * - No events implemented for git file changes (would require file watching)
 * - File changes panel needs updates when Claude edits files
 * - Polling only happens when workspace is actively working (96-100% reduction)
 * - Future: Implement file system events to eliminate polling on desktop
 */
export function useFileChanges(workspaceId: string | null, sessionStatus?: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!);
      return result.files || [];
    },
    enabled: !!workspaceId,
    staleTime: 30000, // 30 seconds for idle workspaces
    // ✅ Poll ONLY when workspace is actively working
    // TODO: Disable on desktop once git file events are implemented
    refetchInterval: sessionStatus === "working" ? 5000 : false,
  });
}

/**
 * Fetch PR status for a workspace
 */
export function usePRStatus(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.prStatus(workspaceId || ""),
    queryFn: () => WorkspaceService.fetchPRStatus(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 5000,
  });
}

/**
 * Fetch dev servers for a workspace
 */
export function useDevServers(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.devServers(workspaceId || ""),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDevServers(workspaceId!);
      return result.servers || [];
    },
    enabled: !!workspaceId,
    staleTime: 3000,
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
      return result.diff;
    },
    enabled: !!workspaceId && !!filePath,
    staleTime: 10000, // Cache for 10s since diffs are expensive
  });
}

/**
 * Create workspace mutation
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (repositoryId: string) => WorkspaceService.create(repositoryId),
    onSuccess: () => {
      // Invalidate workspaces to trigger refetch
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

  return useMutation({
    mutationFn: (workspaceId: string) => WorkspaceService.archive(workspaceId),

    // Optimistic update: Remove workspace from UI immediately
    onMutate: async (workspaceId: string) => {
      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries({ queryKey: queryKeys.workspaces.byRepo("ready") });

      // Snapshot the previous value
      const previousData = queryClient.getQueryData<RepoGroup[]>(
        queryKeys.workspaces.byRepo("ready")
      );

      // Optimistically remove the workspace from the list
      queryClient.setQueryData<RepoGroup[]>(
        queryKeys.workspaces.byRepo("ready"),
        (old) => {
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
        }
      );

      // Return context with the previous value for rollback
      return { previousData };
    },

    // If mutation fails, roll back to the previous value
    onError: (_err, _workspaceId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          queryKeys.workspaces.byRepo("ready"),
          context.previousData
        );
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
    queryKey: ["workspaces", "system-prompt", workspaceId],
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
        queryKey: ["workspaces", "system-prompt", workspaceId],
      });

      const previousPrompt = queryClient.getQueryData<string>([
        "workspaces",
        "system-prompt",
        workspaceId,
      ]);

      queryClient.setQueryData(
        ["workspaces", "system-prompt", workspaceId],
        systemPrompt
      );

      return { previousPrompt };
    },

    onError: (_err, variables, context) => {
      if (context?.previousPrompt !== undefined) {
        queryClient.setQueryData(
          ["workspaces", "system-prompt", variables.workspaceId],
          context.previousPrompt
        );
      }
    },

    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["workspaces", "system-prompt", variables.workspaceId],
      });
    },
  });
}
