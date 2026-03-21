/**
 * Agent Config Service — scope-aware API calls for config management via q:* protocol.
 *
 * All operations accept scope (global/project) and optional repoPath.
 * Reads use sendRequest("agentConfig"), writes use sendMutate("saveAgentConfig"/"deleteAgentConfig").
 */

import { sendRequest, sendMutate } from "@/platform/ws";

export const AgentConfigService = {
  list: <T>(category: string, scope: string, repoPath?: string): Promise<T> => {
    return sendRequest<T>("agentConfig", {
      section: category,
      scope,
      ...(repoPath ? { repoPath } : {}),
    });
  },

  save: async (
    category: string,
    data: Record<string, unknown>,
    scope: string,
    repoPath?: string
  ): Promise<{ success: boolean }> => {
    const result = await sendMutate<{ success: boolean }>("saveAgentConfig", {
      section: category,
      scope,
      ...(repoPath ? { repoPath } : {}),
      ...data,
    });
    if (!result.success) throw new Error(result.error || "Failed to save agent config");
    return result.data ?? { success: true };
  },

  remove: async (
    category: string,
    id: string,
    scope: string,
    repoPath?: string
  ): Promise<{ success: boolean }> => {
    const result = await sendMutate<{ success: boolean }>("deleteAgentConfig", {
      section: category,
      itemId: id,
      scope,
      ...(repoPath ? { repoPath } : {}),
    });
    if (!result.success) throw new Error(result.error || "Failed to delete agent config");
    return result.data ?? { success: true };
  },
};
