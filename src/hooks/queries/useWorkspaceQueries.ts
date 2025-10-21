/**
 * Workspace Query Hooks
 * TanStack Query hooks for workspace-related data fetching
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { WorkspaceService } from '@/services/workspace.service';
import { RepoService } from '@/services/repo.service';
import { queryKeys } from '@/lib/queryKeys';
import { API_CONFIG } from '@/config/api.config';
import type { RepoGroup, DiffStats, FileChange, PRStatus, DevServer } from '@/types';

/**
 * Fetch workspaces grouped by repository with polling
 */
export function useWorkspacesByRepo(state: string = 'ready') {
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
 */
export function useDiffStats(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ''),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: API_CONFIG.POLL_INTERVAL,
    staleTime: 1000,
  });
}

/**
 * Fetch diff stats for multiple workspaces (progressive loading)
 * This replaces the complex progressive loading logic from useDiffStats hook
 */
export function useBulkDiffStats(repoGroups: RepoGroup[]) {
  const queryClient = useQueryClient();

  // Get all workspace IDs
  const workspaceIds = repoGroups.flatMap(g => g.workspaces.map(w => w.id));

  // Create queries for all workspaces
  const queries = useQuery({
    queryKey: ['bulk-diff-stats', workspaceIds],
    queryFn: async () => {
      // Load first 5 immediately
      const first5 = workspaceIds.slice(0, 5);
      const firstResults = await Promise.all(
        first5.map(id => WorkspaceService.fetchDiffStats(id))
      );

      // Cache the first 5 results immediately
      first5.forEach((id, index) => {
        queryClient.setQueryData(
          queryKeys.workspaces.diffStats(id),
          firstResults[index]
        );
      });

      // Load remaining in background (staggered)
      if (workspaceIds.length > 5) {
        const remaining = workspaceIds.slice(5);
        remaining.forEach((id, index) => {
          setTimeout(() => {
            queryClient.prefetchQuery({
              queryKey: queryKeys.workspaces.diffStats(id),
              queryFn: () => WorkspaceService.fetchDiffStats(id),
            });
          }, index * 200);
        });
      }

      // Return aggregated results
      const allStats: Record<string, DiffStats> = {};
      first5.forEach((id, index) => {
        allStats[id] = firstResults[index];
      });
      return allStats;
    },
    enabled: workspaceIds.length > 0,
    refetchInterval: API_CONFIG.POLL_INTERVAL,
    staleTime: 1000,
  });

  return queries;
}

/**
 * Fetch file changes for a workspace
 */
export function useFileChanges(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ''),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!);
      return result.files || [];
    },
    enabled: !!workspaceId,
    staleTime: 5000, // Cache for 5s since file changes are less frequent
  });
}

/**
 * Fetch PR status for a workspace
 */
export function usePRStatus(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.prStatus(workspaceId || ''),
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
    queryKey: queryKeys.workspaces.devServers(workspaceId || ''),
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
    queryKey: queryKeys.workspaces.diffFile(workspaceId || '', filePath || ''),
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
 * Archive workspace mutation
 */
export function useArchiveWorkspace() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => WorkspaceService.archive(workspaceId),
    onSuccess: () => {
      // Invalidate workspaces to trigger refetch
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Fetch system prompt for a workspace
 */
export function useSystemPrompt(workspaceId: string | null) {
  return useQuery({
    queryKey: ['workspaces', 'system-prompt', workspaceId],
    queryFn: async () => {
      const result = await WorkspaceService.fetchSystemPrompt(workspaceId!);
      return result.system_prompt || '';
    },
    enabled: !!workspaceId,
    staleTime: 30000, // System prompts don't change often
  });
}

/**
 * Update system prompt mutation
 */
export function useUpdateSystemPrompt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workspaceId, systemPrompt }: { workspaceId: string; systemPrompt: string }) =>
      WorkspaceService.updateSystemPrompt(workspaceId, systemPrompt),
    onSuccess: (_, variables) => {
      // Invalidate system prompt query for this workspace
      queryClient.invalidateQueries({
        queryKey: ['workspaces', 'system-prompt', variables.workspaceId],
      });
    },
  });
}
