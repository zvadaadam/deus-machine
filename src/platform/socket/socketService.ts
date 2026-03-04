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

/** JSON-RPC 2.0 request structure */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id?: string | number;
}

/** Synchronous ACK/reject from sidecar for query requests */
export interface QueryAckResponse {
  accepted: boolean;
  reason?: string;
}

/** Agent query options */
export interface QueryOptions {
  cwd: string;
  model?: string;
  maxThinkingTokens?: number;
  turnId?: string;
  permissionMode?: string;
  claudeEnvVars?: string;
  ghToken?: string;
  additionalDirectories?: string[];
  chromeEnabled?: boolean;
  strictDataPrivacy?: boolean;
  shouldResetGenerator?: boolean;
  resume?: string;
}

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
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

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
    agentType: "claude" | "codex" | "unknown" = "claude"
  ): Promise<QueryAckResponse> {
    const ack = await this.request<QueryAckResponse>("query", {
      type: "query",
      id: sessionId,
      agentType,
      prompt,
      options,
    });

    if (import.meta.env.DEV)
      console.log("[SOCKET] 📤 Query sent to sidecar-v2:", sessionId.substring(0, 8), ack);

    return ack;
  }

  /**
   * Cancel an active query
   */
  async cancelQuery(
    sessionId: string,
    agentType: "claude" | "codex" | "unknown" = "claude"
  ): Promise<void> {
    await this.request("cancel", {
      type: "cancel",
      id: sessionId,
      agentType,
    });

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
