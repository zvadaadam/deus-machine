/**
 * Repository Query Hooks
 * TanStack Query hooks for repository management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@shared/api";
import type { InputOf } from "@shared/api/op";
import { getErrorMessage } from "@shared/lib/errors";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { useQuerySubscription } from "@/shared/hooks/useQuerySubscription";
import { track } from "@/platform/analytics";

export function useRepos() {
  const enabled = !isCloudDirectWebMode();
  useQuerySubscription(api.repos, { queryKey: queryKeys.repos.all, enabled });
  return useQuery({
    queryKey: queryKeys.repos.all,
    queryFn: () => call(api.repos),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
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
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
    },
  });
}

export function useRemoveRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [api.removeRepo.name],
    mutationFn: (input: InputOf<typeof api.removeRepo>) => call(api.removeRepo, input),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["cloudRepositories"] });
    },
    onError: (error) => toast.error(getErrorMessage(error)),
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
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: ["cloudRepositories"] });
    },
  });
}
