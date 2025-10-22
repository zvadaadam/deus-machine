/**
 * Session Service
 * API methods for Claude Code session management
 */

import { apiClient } from '@/shared/api/client';
import { ENDPOINTS } from '@/shared/config/api.config';
import type { Session, Message } from '../types';

export const SessionService = {
  /**
   * Fetch session by ID
   */
  fetchById: async (id: string): Promise<Session> => {
    return apiClient.get<Session>(ENDPOINTS.SESSION_BY_ID(id));
  },

  /**
   * Fetch messages for a session
   */
  fetchMessages: async (id: string): Promise<Message[]> => {
    return apiClient.get<Message[]>(ENDPOINTS.SESSION_MESSAGES(id));
  },

  /**
   * Send a message to a session
   */
  sendMessage: async (id: string, content: string): Promise<Message> => {
    return apiClient.post<Message>(ENDPOINTS.SESSION_MESSAGES(id), { content });
  },

  /**
   * Stop a running session
   */
  stop: async (id: string): Promise<void> => {
    return apiClient.post<void>(ENDPOINTS.SESSION_STOP(id));
  },
};
