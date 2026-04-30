/**
 * Session Service
 *
 * All data operations go through the WebSocket q:* protocol.
 * Subscribable resources (session, messages) use sendRequest for one-shot reads.
 * Async actions (sendMessage, stopSession) use sendCommand.
 */

import { sendRequest, sendMutate, sendCommand } from "@/platform/ws";
import type { Session, Message } from "../types";
import type { AgentHarness } from "@/shared/agents";

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
   */
  fetchById: async (id: string): Promise<Session> => {
    return sendRequest<Session>("session", { sessionId: id });
  },

  /**
   * Fetch messages for a session with optional cursor-based pagination.
   */
  fetchMessages: async (
    id: string,
    params?: MessagePaginationParams
  ): Promise<PaginatedMessages> => {
    return sendRequest<PaginatedMessages>("messages", {
      sessionId: id,
      ...(params?.limit != null ? { limit: params.limit } : {}),
      ...(params?.before != null ? { before: params.before } : {}),
      ...(params?.after != null ? { after: params.after } : {}),
    });
  },

  /**
   * Send a message to a session
   */
  sendMessage: async (
    id: string,
    content: string,
    model: string,
    agentHarness: AgentHarness
  ): Promise<Message> => {
    const result = await sendCommand("sendMessage", {
      sessionId: id,
      content,
      model,
      agentHarness,
    });
    if (!result.accepted) throw new Error(result.error || "Failed to send message");
    return result as unknown as Message;
  },

  /**
   * Stop a running session
   */
  stop: async (id: string): Promise<void> => {
    const result = await sendCommand("stopSession", { sessionId: id });
    if (!result.accepted) throw new Error(result.error || "Failed to stop session");
  },

  /**
   * Fetch all sessions for a workspace (used by chat tab reconstruction).
   */
  fetchByWorkspace: async (workspaceId: string): Promise<Session[]> => {
    return sendRequest<Session[]>("sessions", { workspaceId });
  },

  /**
   * Create a new session for a workspace.
   * Also updates workspace.current_session_id to the new session.
   */
  createSession: async (workspaceId: string): Promise<Session> => {
    const result = await sendMutate<Session>("createSession", { workspaceId });
    if (!result.success) throw new Error(result.error || "Failed to create session");
    return result.data!;
  },
};
