/**
 * Settings Service
 * API methods for settings management
 */

import { apiClient } from './api';
import type { Settings } from '../types';

export const SettingsService = {
  /**
   * Fetch all settings
   */
  fetch: async (): Promise<Settings> => {
    return apiClient.get<Settings>('/settings');
  },

  /**
   * Update settings
   */
  update: async (settings: Partial<Settings>): Promise<Settings> => {
    return apiClient.post<Settings>('/settings', settings);
  },

  /**
   * Fetch file-based configs (MCP servers, commands, agents, hooks)
   */
  fetchFileConfig: async <T>(type: string): Promise<T> => {
    return apiClient.get<T>(`/settings/${type}`);
  },
};
