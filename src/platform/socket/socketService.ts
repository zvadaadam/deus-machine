/**
 * Unix Socket Service
 *
 * Real-time communication with sidecar-v2 via Unix Domain Socket
 *
 * Architecture:
 * React → Tauri invoke → Rust → Unix Socket → Sidecar-v2 → Claude SDK
 *
 * Protocol: JSON-RPC 2.0 over NDJSON
 *
 * Note: In web mode (non-Tauri), this service is disabled and returns mock responses
 */

import { invoke, isTauriEnv } from "@/platform/tauri";
import type { AgentType } from "@shared/enums";
import { QueryAckResponseSchema, SIDECAR_METHODS } from "@shared/protocol";
import type { CancelRequest, QueryAckResponse, QueryOptions, QueryRequest } from "@shared/protocol";

// Re-export shared types for downstream consumers
export type { QueryAckResponse, QueryOptions };

/**
 * Unix Socket Service (Singleton)
 *
 * Manages JSON-RPC 2.0 communication with sidecar-v2
 */
class UnixSocketService {
  private socketPath: string | null = null;
  private connected: boolean = false;
  private rpcIdCounter: number = 0;

  /**
   * Initialize connection to sidecar-v2 Unix socket
   * Socket path is obtained from Rust SidecarManager (auto-discovered on startup)
   */
  async connect(): Promise<void> {
    // Skip in web mode (non-Tauri)
    if (!isTauriEnv) {
      if (import.meta.env.DEV)
        console.log("[SOCKET] ⚠️  Running in web mode - socket features disabled");
      return;
    }

    try {
      // Check if Rust already connected during app startup (avoids double-connection bug)
      const alreadyConnected = await invoke<boolean>("is_sidecar_connected");
      if (alreadyConnected) {
        this.socketPath = await invoke<string | null>("get_sidecar_socket_path");
        this.connected = true;
        if (import.meta.env.DEV) console.log("[SOCKET] ✅ Already connected (Rust auto-connected)");
        return;
      }

      // Get socket path from Rust SidecarManager (not HTTP endpoint)
      const socketPath = await invoke<string | null>("get_sidecar_socket_path");

      if (!socketPath) {
        throw new Error("Sidecar socket path not available (sidecar-v2 may not be running)");
      }

      this.socketPath = socketPath;

      // Connect via Tauri Rust
      await invoke("connect_to_sidecar", { socketPath: this.socketPath });

      this.connected = true;
      if (import.meta.env.DEV) console.log("[SOCKET] ✅ Connected to sidecar-v2:", this.socketPath);
    } catch (error) {
      console.error("[SOCKET] ❌ Connection failed:", error);
      throw error;
    }
  }

  /**
   * Send JSON-RPC request (expects response)
   */
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.connected && isTauriEnv) {
      await this.connect();
    }

    if (!this.connected) {
      throw new Error("Not connected to sidecar socket");
    }

    const id = ++this.rpcIdCounter;
    const request = { jsonrpc: "2.0" as const, method, params, id };

    let response: Record<string, unknown>;
    try {
      const messageStr = JSON.stringify(request);
      await invoke("send_sidecar_message", { message: messageStr });

      // Wait for response
      const responseStr = await invoke<string>("receive_sidecar_message");
      response = JSON.parse(responseStr);
    } catch (error) {
      // Transport-level failure (socket disconnected, Rust IPC error, timeout)
      console.error("[SOCKET] ❌ Request failed:", error);
      this.connected = false;
      throw error;
    }

    // Application-level JSON-RPC error — transport is healthy, sidecar
    // processed the request but returned an error response.
    if (response.error) {
      const rpcError = response.error as { message?: string };
      throw new Error(rpcError.message || "RPC error");
    }

    return response.result as T;
  }

  /**
   * Send agent query to sidecar-v2
   *
   * Sends a "query" request and waits for synchronous ACK/reject.
   * Streaming responses are received via Tauri events (session:message).
   */
  async sendQuery(
    sessionId: string,
    prompt: string,
    options: QueryOptions,
    agentType: AgentType = "claude"
  ): Promise<QueryAckResponse> {
    // Typed against QueryRequest — compiler catches shape mismatches
    // if shared/protocol.ts adds or changes fields.
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
      console.log("[SOCKET] 📤 Query sent to sidecar-v2:", sessionId.substring(0, 8), parsed.data);

    return parsed.data;
  }

  /**
   * Cancel an active query
   */
  async cancelQuery(
    sessionId: string,
    agentType: AgentType = "claude"
  ): Promise<void> {
    const params: CancelRequest = {
      type: "cancel",
      id: sessionId,
      agentType,
    };
    await this.request(SIDECAR_METHODS.CANCEL, params);

    if (import.meta.env.DEV) console.log("[SOCKET] 🛑 Query cancelled:", sessionId.substring(0, 8));
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}

// Export singleton instance
export const socketService = new UnixSocketService();
