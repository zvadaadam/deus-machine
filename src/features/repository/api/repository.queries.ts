/**
 * Repository Query Hooks
 * TanStack Query hooks for repository management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RepoService } from './repository.service';
import { queryKeys } from '@/shared/api/queryKeys';
import type { Repo } from '../types';

/**
 * Fetch all repositories
 */
export function useRepos() {
  return useQuery({
    queryKey: queryKeys.repos.all,
    queryFn: () => RepoService.fetchAll(),
    staleTime: 10000, // Repos don't change often
  });
}

/**
 * Fetch single repository by ID
 */
export function useRepo(id: string | null) {
  return useQuery({
    queryKey: queryKeys.repos.detail(id || ''),
    queryFn: () => RepoService.fetchById(id!),
    enabled: !!id,
    staleTime: 10000,
  });
}

/**
 * Add repository mutation
 */
export function useAddRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (rootPath: string) => RepoService.add(rootPath),
    onSuccess: () => {
      // Invalidate repos and workspaces (new repo means new potential workspaces)
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Clone repository mutation
 */
export function useCloneRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ url, path }: { url: string; path: string }) =>
      RepoService.clone(url, path),
    onSuccess: () => {
      // Invalidate repos and workspaces
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}
