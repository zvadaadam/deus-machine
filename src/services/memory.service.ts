/**
 * Memory Service
 * API methods for conversation memory management
 */

import { apiClient } from './api';

export const MemoryService = {
  /**
   * Clear all conversation memory
   */
  clear: async (): Promise<void> => {
    return apiClient.post<void>('/memory/clear');
  },
};
