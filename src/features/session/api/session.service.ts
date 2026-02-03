/**
 * Session Service
 * API methods for Claude Code session management
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import type { Session, Message } from "../types";

/** Pagination params for cursor-based message fetching */
export interface MessagePaginationParams {
  limit?: number;
  before?: string; // sent_at cursor for older messages
  after?: string; // sent_at cursor for newer messages
}

/** Paginated response shape from GET /sessions/:id/messages */
export interface PaginatedMessages {
  messages: Message[];
  has_older: boolean;
  has_newer: boolean;
}

export const SessionService = {
  /**
   * Fetch session by ID
   */
  fetchById: async (id: string): Promise<Session> => {
    return apiClient.get<Session>(ENDPOINTS.SESSION_BY_ID(id));
  },

  /**
   * Fetch messages for a session with optional cursor-based pagination.
   * Returns paginated response with messages array and has_older/has_newer flags.
   */
  fetchMessages: async (
    id: string,
    params?: MessagePaginationParams
  ): Promise<PaginatedMessages> => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.before) searchParams.set("before", params.before);
    if (params?.after) searchParams.set("after", params.after);
    const qs = searchParams.toString();
    const url = qs ? `${ENDPOINTS.SESSION_MESSAGES(id)}?${qs}` : ENDPOINTS.SESSION_MESSAGES(id);
    return apiClient.get<PaginatedMessages>(url);
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
