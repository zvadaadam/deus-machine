/**
 * Repository Query Hooks
 * TanStack Query hooks for repository management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";

/**
 * Fetch all repositories
 */
export function useRepos() {
  return useQuery({
    queryKey: queryKeys.repos.all,
    queryFn: () => call(api.repos),
    staleTime: 10000, // Repos don't change often
  });
}

/**
 * Add repository mutation
 */
export function useAddRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (rootPath: string) => call(api.addRepo, { root_path: rootPath }),
    onSuccess: (_data, rootPath) => {
      track("repo_added", { repo_name: rootPath.split("/").pop() });
      // Invalidate repos and workspaces (new repo means new potential workspaces)
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

/** The repositories a cloud organization's GitHub App can reach, while the add dialog is open. */
export function useCloudRepositories(organizationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.repos.cloud(organizationId),
    queryFn: () => call(api.cloudRepositories, { organizationId }),
    enabled,
    // Asked again when the person comes back from installing the GitHub App.
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** Add a GitHub repository as a project with no folder here (nothing is cloned). */
export function useAddCloudRepo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { repository: string; organizationId: string | null }) =>
      call(api.addCloudRepo, input),
    onSuccess: (repo) => {
      track("repo_added", { repo_name: repo.name });
      queryClient.invalidateQueries({ queryKey: queryKeys.repos.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: ["cloudRepositories"] });
    },
  });
}
