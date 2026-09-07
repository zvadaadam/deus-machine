/**
 * Repository Query Hooks
 * TanStack Query hooks for repository management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RepoService } from "./repository.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";
import type { Repository } from "../types";
import type { ManifestResponse } from "@shared/types/manifest";

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
 *
 * Writes the just-saved manifest SYNCHRONOUSLY into the manifest cache on
 * success, instead of invalidating+refetching. The manifest query uses
 * `staleTime: Infinity` (the manifest only changes via this hook), so the
 * cache is the source of truth and a refetch would only re-read what we just
 * wrote. An invalidation+refetch also opens an async window the editor's
 * manifestData-resync effect (in EnvironmentSection) can clobber user edits
 * typed during the save round-trip through: the snapshot taken at mutate()
 * time does not include keystrokes landed before the refetch resolves, and
 * the resync then resets the local draft to the smaller saved manifest.
 * setQueryData collapses that window by settling the cache in the same tick
 * as the save success — and the editor's resync effect additionally guards
 * against the post-save reflection clobbering in-flight edits.
 */
export function useSaveRepoManifest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ repoId, manifest }: { repoId: string; manifest: Record<string, unknown> }) =>
      RepoService.saveManifest(repoId, manifest),
    onSuccess: (_data, { repoId, manifest }) => {
      queryClient.setQueryData<ManifestResponse>(queryKeys.repos.manifest(repoId), (prev) => ({
        manifest,
        tasks: prev?.tasks ?? [],
      }));
      // Workspace manifests inherit from the repo manifest; refetch those so
      // they pick up the new setup/tasks configuration on next read.
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
