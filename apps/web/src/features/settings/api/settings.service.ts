/**
 * Settings Service
 * API methods for settings management via WebSocket q:* protocol.
 */

import { sendRequest, sendMutate } from "@/platform/ws";
import type { Settings, AgentAuthStatus } from "../types";

export const SettingsService = {
  /**
   * Fetch all settings
   */
  fetch: async (): Promise<Settings> => {
    return sendRequest<Settings>("settings");
  },

  /**
   * Update a single setting. The mutation always passes one key at a time
   * as Partial<Settings>, but the backend expects { key, value } format.
   */
  update: async (settings: Partial<Settings>): Promise<Settings> => {
    const [key, value] = Object.entries(settings)[0];
    const result = await sendMutate<Settings>("saveSetting", { key, value });
    if (!result.success) throw new Error(result.error || "Failed to save setting");
    return result.data!;
  },

  /**
   * Fetch file-based configs (MCP servers, commands, agents, hooks)
   */
  fetchFileConfig: async <T>(type: string): Promise<T> => {
    return sendRequest<T>("agentConfig", { section: type });
  },

  /**
   * Fetch agent provider auth status (Claude / Codex)
   */
  fetchAgentAuth: async (): Promise<AgentAuthStatus> => {
    return sendRequest<AgentAuthStatus>("agentAuth");
  },
};
