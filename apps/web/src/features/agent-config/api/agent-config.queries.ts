/**
 * Agent Config Query Hooks — TanStack Query v5
 *
 * One list hook per scope+section. Category views call it with their section
 * and get that section's type back.
 *
 * In "both" mode, the UI component calls the hook twice (once for
 * global, once for project) and merges results.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type InputOf } from "@shared/api";
import type { AgentConfigSection } from "@shared/types/agent-config";
import { getErrorMessage } from "@shared/lib/errors";
import { call } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";
import type { ConfigScope } from "../types";
import { readAgentConfig } from "./agent-config.service";

/** Fetch one section's config items for a scope. */
export function useAgentConfigList<Section extends AgentConfigSection>(
  section: Section,
  scope: ConfigScope,
  repoPath?: string,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.agentConfig.category(section, scope, repoPath),
    queryFn: () => readAgentConfig(section, scope, repoPath),
    staleTime: 30_000,
    enabled: options?.enabled,
  });
}

/** The section's cache entry a write just made stale. */
function categoryKey(input: { section: string; scope?: ConfigScope; repoPath?: string }) {
  return queryKeys.agentConfig.category(input.section, input.scope ?? "global", input.repoPath);
}

/**
 * Save (create or update) a config item, or a whole section for the ones saved
 * whole. Invalidates the section's cache on success.
 */
export function useSaveConfigItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: InputOf<typeof api.saveAgentConfig>) => call(api.saveAgentConfig, input),

    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: categoryKey(input) });
    },

    onError: (error) => {
      toast.error(`Failed to save: ${getErrorMessage(error)}`);
    },
  });
}

/**
 * Delete a config item.
 * Invalidates the section's cache on success.
 */
export function useDeleteConfigItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: InputOf<typeof api.deleteAgentConfig>) =>
      call(api.deleteAgentConfig, input),

    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: categoryKey(input) });
    },

    onError: (error) => {
      toast.error(`Failed to delete: ${getErrorMessage(error)}`);
    },
  });
}
