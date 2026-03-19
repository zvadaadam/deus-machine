/**
 * Session Service
 * API methods for Claude Code session management
 */

import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import { isElectronAvailable } from "@/platform/electron/invoke";
import { dbGetSession, dbGetMessages } from "@/platform/electron/db";
import type { Session, Message } from "../types";

/** Pagination params for cursor-based message fetching (seq-based) */
export interface MessagePaginationParams {
  limit?: number;
  before?: number; // seq cursor for older messages
  after?: number; // seq cursor for newer messages
}

/** Paginated response shape from GET /sessions/:id/messages */
export interface PaginatedMessages {
  messages: Message[];
  has_older: boolean;
  has_newer: boolean;
}

export const SessionService = {
  /**
   * Fetch session by ID.
   * Uses direct DB IPC when available (~1ms),
   * falls back to Node.js HTTP when in web mode.
   */
  fetchById: async (id: string): Promise<Session> => {
    if (isElectronAvailable()) {
      try {
        const session = await dbGetSession(id);
        if (session) return session;
      } catch {
        // Rust DB failed — fall through to HTTP
      }
    }
    return apiClient.get<Session>(ENDPOINTS.SESSION_BY_ID(id));
  },

  /**
   * Fetch messages for a session with optional cursor-based pagination.
   * Uses direct DB IPC when available (~1ms),
   * falls back to Node.js HTTP when in web mode.
   */
  fetchMessages: async (
    id: string,
    params?: MessagePaginationParams
  ): Promise<PaginatedMessages> => {
    if (isElectronAvailable()) {
      try {
        return await dbGetMessages(id, {
          limit: params?.limit,
          before: params?.before,
          after: params?.after,
        });
      } catch {
        // Rust DB failed — fall through to HTTP
      }
    }
    const searchParams = new URLSearchParams();
    if (params?.limit != null) searchParams.set("limit", String(params.limit));
    if (params?.before != null) searchParams.set("before", String(params.before));
    if (params?.after != null) searchParams.set("after", String(params.after));
    const qs = searchParams.toString();
    const url = qs ? `${ENDPOINTS.SESSION_MESSAGES(id)}?${qs}` : ENDPOINTS.SESSION_MESSAGES(id);
    return apiClient.get<PaginatedMessages>(url);
  },

  /**
   * Send a message to a session
   */
  sendMessage: async (id: string, content: string, model?: string): Promise<Message> => {
    return apiClient.post<Message>(ENDPOINTS.SESSION_MESSAGES(id), { content, model });
  },

  /**
   * Stop a running session
   */
  stop: async (id: string): Promise<void> => {
    return apiClient.post<void>(ENDPOINTS.SESSION_STOP(id));
  },

  /**
   * Fetch all sessions for a workspace (used by chat tab reconstruction).
   */
  fetchByWorkspace: async (workspaceId: string): Promise<Session[]> => {
    return apiClient.get<Session[]>(ENDPOINTS.WORKSPACE_SESSIONS(workspaceId));
  },

  /**
   * Create a new session for a workspace.
   * Also updates workspace.current_session_id to the new session.
   */
  createSession: async (workspaceId: string): Promise<Session> => {
    return apiClient.post<Session>(ENDPOINTS.WORKSPACE_SESSIONS(workspaceId), {});
  },
};
