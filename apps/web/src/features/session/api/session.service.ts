/**
 * Session Service
 *
 * All data operations go through the WebSocket q:* protocol.
 * Subscribable resources (session, messages) use sendRequest for one-shot reads.
 * Async actions (sendMessage, stopSession) use sendCommand.
 */

import { sendRequest, sendMutate, sendCommand } from "@/platform/ws";
import type { Compaction, Session, Message } from "../types";
import type { AgentHarness } from "@/shared/agents";

/** Pagination params for cursor-based message fetching (seq-based) */
export interface MessagePaginationParams {
  limit?: number;
  before?: number; // seq cursor for older messages
  after?: number; // seq cursor for newer messages
}

/**
 * Paginated response shape from the `messages` query — the WS resource and its
 * HTTP fallback `GET /sessions/:id/messages` both answer exactly this.
 */
export interface PaginatedMessages {
  messages: Message[];
  /**
   * Compaction markers for the session — positional siblings of messages.
   *
   * REQUIRED, not optional. Both producers always send the list (empty when
   * there are none), and while the type said `?` a producer that forgot it was
   * indistinguishable from a session that has never compacted: every divider
   * vanished from the transcript and nothing in the types objected. The HTTP
   * fallback route was exactly that producer.
   */
  compactions: Compaction[];
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
   * Send a message to a session.
   *
   * `turnId` is REQUIRED, and the type now says so. It is the key the engine's
   * user echo comes back with, and the composer already stamped it on the
   * optimistic bubble; omitting it makes the backend mint a different one, so
   * the echo lands under an id nothing is holding and the bubble sits beside
   * its own echo. The old optional signature documented the requirement in
   * prose while letting the compiler wave through the one call that breaks it.
   */
  sendMessage: async (
    id: string,
    content: string,
    model: string,
    agentHarness: AgentHarness,
    turnId: string
  ): Promise<Message> => {
    const result = await sendCommand("sendMessage", {
      sessionId: id,
      content,
      model,
      agentHarness,
      turnId,
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
