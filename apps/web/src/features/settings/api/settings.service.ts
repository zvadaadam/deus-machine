/**
 * Settings Service
 * API methods for settings management
 */

import { apiClient } from "@/shared/api/client";
import type { Settings } from "../types";

export const SettingsService = {
  /**
   * Fetch all settings
   */
  fetch: async (): Promise<Settings> => {
    return apiClient.get<Settings>("/settings");
  },

  /**
   * Update a single setting. The mutation always passes one key at a time
   * as Partial<Settings>, but the backend expects { key, value } format.
   */
  update: async (settings: Partial<Settings>): Promise<Settings> => {
    const [key, value] = Object.entries(settings)[0];
    return apiClient.post<Settings>("/settings", { key, value });
  },

  /**
   * Fetch file-based configs (MCP servers, commands, agents, hooks)
   */
  fetchFileConfig: async <T>(type: string): Promise<T> => {
    return apiClient.get<T>(`/config/${type}`);
  },
};
