/**
 * Repository Query Hooks
 * TanStack Query hooks for repository management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RepoService } from "./repository.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";

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
