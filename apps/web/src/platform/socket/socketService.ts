/**
 * Sidecar Socket Service
 *
 * Communication with the agent-server (sidecar) via backend HTTP endpoints.
 *
 * Architecture:
 * React → HTTP → Backend → WebSocket → Agent-Server → Claude SDK
 *
 * Protocol: JSON-RPC 2.0 over NDJSON (backend handles the socket relay)
 */

import { getBackendUrl } from "@/shared/config/api.config";
import type { AgentType } from "@shared/enums";
import { QueryAckResponseSchema, SIDECAR_METHODS } from "@shared/protocol";
import type { CancelRequest, QueryAckResponse, QueryOptions, QueryRequest } from "@shared/protocol";

export type { QueryAckResponse, QueryOptions };

/**
 * Sidecar Socket Service (Singleton)
 *
 * Sends JSON-RPC 2.0 messages to sidecar via backend HTTP relay.
 */
class SidecarSocketService {
  private rpcIdCounter: number = 0;

  /**
   * Initialize — check if backend sidecar is connected.
   */
  async connect(): Promise<void> {
    try {
      const baseUrl = await getBackendUrl();
      const res = await fetch(`${baseUrl}/api/sidecar/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { connected } = await res.json();
      if (!connected) {
        console.warn("[SOCKET] Sidecar not yet connected on backend");
      }
    } catch (error) {
      console.error("[SOCKET] Connection check failed:", error);
      throw error;
    }
  }

  /**
   * Send JSON-RPC request to sidecar via backend relay.
   */
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.rpcIdCounter;
    const rpcMessage = JSON.stringify({ jsonrpc: "2.0", method, params, id });

    const baseUrl = await getBackendUrl();
    const res = await fetch(`${baseUrl}/api/sidecar/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: rpcMessage }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const { response: responseStr } = await res.json();
    const response = JSON.parse(responseStr);

    if (response.error) {
      const rpcError = response.error as { message?: string };
      throw new Error(rpcError.message || "RPC error");
    }

    return response.result as T;
  }

  /**
   * Send agent query to the agent-server
   */
  async sendQuery(
    sessionId: string,
    prompt: string,
    options: QueryOptions,
    agentType: AgentType = "claude"
  ): Promise<QueryAckResponse> {
    const params: QueryRequest = {
      type: "query",
      id: sessionId,
      agentType,
      prompt,
      options,
    };
    const raw = await this.request<QueryAckResponse>(SIDECAR_METHODS.QUERY, params);
    const parsed = QueryAckResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("[SOCKET] Invalid QueryAckResponse from sidecar:", parsed.error.message);
      return { accepted: false, reason: "Invalid response from sidecar" };
    }

    if (import.meta.env.DEV)
      console.log("[SOCKET] Query sent to agent-server:", sessionId.substring(0, 8), parsed.data);

    return parsed.data;
  }

  /**
   * Cancel an active query
   */
  async cancelQuery(sessionId: string, agentType: AgentType = "claude"): Promise<void> {
    const params: CancelRequest = {
      type: "cancel",
      id: sessionId,
      agentType,
    };
    await this.request(SIDECAR_METHODS.CANCEL, params);

    if (import.meta.env.DEV) console.log("[SOCKET] Query cancelled:", sessionId.substring(0, 8));
  }

  /**
   * Check if connected (always true since backend manages the socket)
   */
  isConnected(): boolean {
    return true; // Backend manages the socket connection
  }
}

export const socketService = new SidecarSocketService();
