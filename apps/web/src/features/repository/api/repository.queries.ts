/**
 * Repository Query Hooks
 * TanStack Query hooks for repository management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RepoService } from "./repository.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";
import type { Repository } from "../types";

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
 * Fetch deus.json manifest for a repo.
 * staleTime: Infinity — manifest doesn't change unless user saves.
 */
export function useRepoManifest(repoId: string | null) {
  return useQuery({
    queryKey: queryKeys.repos.manifest(repoId || ""),
    queryFn: () => RepoService.fetchManifest(repoId!),
    enabled: !!repoId,
    staleTime: Infinity,
  });
}

/**
 * Save deus.json manifest for a repo.
 * Invalidates the manifest query on success.
 */
export function useSaveRepoManifest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ repoId, manifest }: { repoId: string; manifest: Record<string, unknown> }) =>
      RepoService.saveManifest(repoId, manifest),
    onSuccess: (_data, { repoId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.manifest(repoId) });
      // Also invalidate workspace manifests since they inherit from repo
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/**
 * Add repository mutation
 */
export function useAddRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (rootPath: string) => RepoService.add(rootPath),
    onSuccess: (_data, rootPath) => {
      track("repo_added", { repo_name: rootPath.split("/").pop() });
      // Invalidate repos and workspaces (new repo means new potential workspaces)
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}
