/**
 * Settings Query Hooks
 * TanStack Query hooks for settings management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { produce } from "immer";
import { SettingsService } from "./settings.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { track } from "@/platform/analytics";
import type { Settings, MCPServer, Command, Agent } from "../types";

/**
 * Fetch all settings
 */
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: () => SettingsService.fetch(),
    staleTime: 30000, // Cache for 30s (settings change less frequently)
  });
}

/**
 * Fetch MCP servers configuration
 */
export function useMCPServers() {
  return useQuery({
    queryKey: queryKeys.settings.mcpServers,
    queryFn: () => SettingsService.fetchFileConfig<MCPServer[]>("mcp-servers"),
    staleTime: 30000,
  });
}

/**
 * Fetch commands configuration
 */
export function useCommands() {
  return useQuery({
    queryKey: queryKeys.settings.commands,
    queryFn: () => SettingsService.fetchFileConfig<Command[]>("commands"),
    staleTime: 30000,
  });
}

/**
 * Fetch agents configuration
 */
export function useAgents() {
  return useQuery({
    queryKey: queryKeys.settings.agents,
    queryFn: () => SettingsService.fetchFileConfig<Agent[]>("agents"),
    staleTime: 30000,
  });
}

/**
 * Fetch agent provider auth status (Claude / Codex)
 */
export function useAgentAuth() {
  return useQuery({
    queryKey: queryKeys.settings.agentAuth,
    queryFn: () => SettingsService.fetchAgentAuth(),
    staleTime: 60000, // Cache for 60s — auth status changes infrequently
  });
}

/**
 * Update settings mutation with optimistic update
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Partial<Settings>) => SettingsService.update(settings),

    // Optimistic update: Apply settings immediately
    onMutate: async (newSettings: Partial<Settings>) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings.all });

      const previousSettings = queryClient.getQueryData<Settings>(queryKeys.settings.all);

      queryClient.setQueryData<Settings>(queryKeys.settings.all, (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          Object.assign(draft, newSettings);
        });
      });

      return { previousSettings };
    },

    onError: (_err, _newSettings, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.settings.all, context.previousSettings);
      }
    },

    onSuccess: (_data, newSettings) => {
      // Track each changed key. Only include value for safe enum-type settings
      // (theme, provider). Never log API keys or free-text inputs.
      const SAFE_VALUE_KEYS = new Set(["theme", "claude_provider"]);
      for (const key of Object.keys(newSettings)) {
        const value = SAFE_VALUE_KEYS.has(key)
          ? String((newSettings as Record<string, unknown>)[key])
          : undefined;
        track("setting_changed", { key, value });
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}
