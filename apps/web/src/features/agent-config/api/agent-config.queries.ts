/**
 * Agent Config Query Hooks — TanStack Query v5
 *
 * One generic list hook per scope+category. Category views call this
 * with their specific type parameter.
 *
 * In "both" mode, the UI component calls the hook twice (once for
 * global, once for project) and merges results.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { queryKeys } from "@/shared/api/queryKeys";
import { AgentConfigService } from "./agent-config.service";
import { getErrorMessage } from "@shared/lib/errors";

/**
 * Fetch config items for a category + scope.
 * T = the shape the backend returns (e.g. SkillItem[], CommandItem[], etc.)
 */
export function useAgentConfigList<T>(
  category: string,
  scope: string,
  repoPath?: string,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.agentConfig.category(category, scope, repoPath),
    queryFn: () => AgentConfigService.list<T>(category, scope, repoPath),
    staleTime: 30_000,
    enabled: options?.enabled,
  });
}

/**
 * Save (create or update) a config item.
 * Invalidates the category cache on success.
 */
export function useSaveConfigItem(category: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { data: Record<string, unknown>; scope: string; repoPath?: string }) =>
      AgentConfigService.save(category, params.data, params.scope, params.repoPath),

    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentConfig.category(category, variables.scope, variables.repoPath),
      });
    },

    onError: (error) => {
      toast.error(`Failed to save: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Delete a config item.
 * Invalidates the category cache on success.
 */
export function useDeleteConfigItem(category: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { id: string; scope: string; repoPath?: string }) =>
      AgentConfigService.remove(category, params.id, params.scope, params.repoPath),

    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentConfig.category(category, variables.scope, variables.repoPath),
      });
    },

    onError: (error) => {
      toast.error(`Failed to delete: ${getErrorMessage(error)}`);
    },
  });
}
