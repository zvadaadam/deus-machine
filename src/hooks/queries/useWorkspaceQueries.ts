/**
 * Workspace Query Hooks
 * TanStack Query hooks for workspace-related data fetching
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { WorkspaceService } from '@/services/workspace.service';
import { RepoService } from '@/features/repository/api/repository.service';
import { queryKeys } from '@/shared/api/queryKeys';
import { API_CONFIG } from '@/shared/config/api.config';
import type { RepoGroup, DiffStats, FileChange, PRStatus, DevServer } from '@/shared/types';

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

  // Stable, de-duplicated IDs for keying and effects
  const workspaceIds = useMemo(() => {
    const ids = repoGroups.flatMap(g => g.workspaces.map(w => w.id));
    return Array.from(new Set(ids)).sort(); // stable order
  }, [repoGroups]);

  // Prime cache for first N and return aggregate
  const query = useQuery({
    queryKey: ['bulk-diff-stats', workspaceIds],
    enabled: workspaceIds.length > 0,
    staleTime: 1000,
    queryFn: async () => {
      const first5 = workspaceIds.slice(0, 5);
      const firstResults = await Promise.all(
        first5.map(id => WorkspaceService.fetchDiffStats(id))
      );

      // Cache first 5 results immediately
      first5.forEach((id, i) => {
        queryClient.setQueryData(queryKeys.workspaces.diffStats(id), firstResults[i]);
      });

      // Aggregate from cache (includes any previously prefetched items)
      const aggregate: Record<string, DiffStats> = {};
      workspaceIds.forEach(id => {
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
              const existing = queryClient.getQueryData<Record<string, DiffStats>>(['bulk-diff-stats', workspaceIds]) || {};
              queryClient.setQueryData(['bulk-diff-stats', workspaceIds], { ...existing, [id]: data });
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
