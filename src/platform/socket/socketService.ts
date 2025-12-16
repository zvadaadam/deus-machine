/**
 * Unix Socket Service
 *
 * Real-time communication with Claude CLI via Unix Domain Socket
 *
 * Architecture:
 * React → Tauri invoke → Rust → Unix Socket → Node Sidecar → Claude CLI
 *
 * Note: In web mode (non-Tauri), this service is disabled and returns mock responses
 */

import { invoke, isTauriEnv } from "@/platform/tauri";

export interface SocketMessage {
  command: string;
  [key: string]: any;
}

export interface SocketResponse {
  success?: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Unix Socket Service (Singleton)
 */
class UnixSocketService {
  private socketPath: string | null = null;
  private connected: boolean = false;
  // Reserved for future message handling implementation
  // private messageHandlers: Map<string, (data: any) => void> = new Map();

  /**
   * Initialize connection to sidecar Unix socket
   */
  async connect(): Promise<void> {
    // Skip in web mode (non-Tauri)
    if (!isTauriEnv) {
      if (import.meta.env.DEV)
        console.log("[SOCKET] ⚠️  Running in web mode - socket features disabled");
      return;
    }

    try {
      // 1. Get socket path from backend (using dynamic port)
      const { getBaseURL } = await import("@/shared/config/api.config");
      const baseURL = await getBaseURL();
      const response = await fetch(`${baseURL}/sidecar/status`);
      const status = await response.json();

      if (!status.socketPath) {
        throw new Error("Socket path not available");
      }

      this.socketPath = status.socketPath;

      // 2. Connect via Tauri Rust (using platform wrapper)
      await invoke("connect_to_sidecar", { socketPath: this.socketPath });

      this.connected = true;
      if (import.meta.env.DEV) console.log("[SOCKET] ✅ Connected to:", this.socketPath);
    } catch (error) {
      console.error("[SOCKET] ❌ Connection failed:", error);
      throw error;
    }
  }

  /**
   * Send message to sidecar
   */
  async send(message: SocketMessage): Promise<SocketResponse> {
    if (!this.connected) {
      throw new Error("Not connected to socket");
    }

    try {
      // Send NDJSON message via Rust (using platform wrapper)
      const messageStr = JSON.stringify(message);
      await invoke("send_sidecar_message", { message: messageStr });

      // Receive response
      const responseStr = await invoke<string>("receive_sidecar_message");
      const response = JSON.parse(responseStr);

      return response;
    } catch (error) {
      console.error("[SOCKET] ❌ Send failed:", error);
      throw error;
    }
  }

  /**
   * Start Claude session
   */
  async startSession(sessionId: string, workspacePath: string): Promise<SocketResponse> {
    return this.send({
      command: "start_session",
      sessionId,
      workspacePath,
    });
  }

  /**
   * Send message to Claude
   */
  async sendMessage(sessionId: string, content: string): Promise<SocketResponse> {
    return this.send({
      command: "send_message",
      sessionId,
      content,
    });
  }

  /**
   * Stop Claude session
   */
  async stopSession(sessionId: string): Promise<SocketResponse> {
    return this.send({
      command: "stop_session",
      sessionId,
    });
  }

  /**
   * Get session messages
   */
  async getMessages(sessionId: string): Promise<SocketResponse> {
    return this.send({
      command: "get_messages",
      sessionId,
    });
  }

  /**
   * Disconnect from socket
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await invoke("disconnect_from_sidecar");
        this.connected = false;
        this.socketPath = null;
        if (import.meta.env.DEV) console.log("[SOCKET] 🔌 Disconnected");
      } catch (error) {
        console.error("[SOCKET] ❌ Disconnect failed:", error);
      }
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get socket path
   */
  getSocketPath(): string | null {
    return this.socketPath;
  }
}

// Export singleton instance
export const socketService = new UnixSocketService();
