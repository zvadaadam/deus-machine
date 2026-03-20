/**
 * Agent Config Service — scope-aware API calls for config management.
 *
 * All endpoints accept scope (global/project) and optional repoPath.
 * Query params are appended to the endpoint URL since apiClient.get()
 * takes a plain string endpoint.
 */

import { apiClient } from "@/shared/api/client";

function buildQueryString(scope: string, repoPath?: string): string {
  const params = new URLSearchParams({ scope });
  if (repoPath) params.set("repoPath", repoPath);
  return params.toString();
}

export const AgentConfigService = {
  list: <T>(category: string, scope: string, repoPath?: string): Promise<T> => {
    const qs = buildQueryString(scope, repoPath);
    return apiClient.get<T>(`/agent-config/${category}?${qs}`);
  },

  save: (
    category: string,
    data: Record<string, unknown>,
    scope: string,
    repoPath?: string
  ): Promise<{ success: boolean }> => {
    const qs = buildQueryString(scope, repoPath);
    return apiClient.post(`/agent-config/${category}?${qs}`, data);
  },

  remove: (
    category: string,
    id: string,
    scope: string,
    repoPath?: string
  ): Promise<{ success: boolean }> => {
    const qs = buildQueryString(scope, repoPath);
    return apiClient.delete(`/agent-config/${category}/${encodeURIComponent(id)}?${qs}`);
  },
};
