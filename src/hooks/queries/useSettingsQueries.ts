/**
 * Settings Query Hooks
 * TanStack Query hooks for settings management
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SettingsService } from '@/services/settings.service';
import { queryKeys } from '@/shared/api/queryKeys';
import type { Settings, MCPServer, Command, Agent, Hook } from '@/shared/types';

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
    queryFn: () => SettingsService.fetchFileConfig<MCPServer[]>('mcp-servers'),
    staleTime: 30000,
  });
}

/**
 * Fetch commands configuration
 */
export function useCommands() {
  return useQuery({
    queryKey: queryKeys.settings.commands,
    queryFn: () => SettingsService.fetchFileConfig<Command[]>('commands'),
    staleTime: 30000,
  });
}

/**
 * Fetch agents configuration
 */
export function useAgents() {
  return useQuery({
    queryKey: queryKeys.settings.agents,
    queryFn: () => SettingsService.fetchFileConfig<Agent[]>('agents'),
    staleTime: 30000,
  });
}

/**
 * Fetch hooks configuration
 */
export function useHooks() {
  return useQuery({
    queryKey: queryKeys.settings.hooks,
    queryFn: () => SettingsService.fetchFileConfig<Hook>('hooks'),
    staleTime: 30000,
  });
}

/**
 * Update settings mutation
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Partial<Settings>) => SettingsService.update(settings),
    onSuccess: () => {
      // Invalidate all settings queries to trigger refetch
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}

/**
 * Clear conversation memory mutation
 */
export function useClearMemory() {
  return useMutation({
    mutationFn: async () => {
      const { MemoryService } = await import('@/services/memory.service');
      return MemoryService.clear();
    },
  });
}
