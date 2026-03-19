// backend/src/services/agent/client.ts
// WebSocket client that connects to the agent-server (sidecar).
//
// Implements the JSON-RPC 2.0 handshake protocol:
//   Backend → Agent: { method: "initialize", params: { version: "1.0", capabilities: {} } }
//   Agent → Backend: { result: { version: "1.0", agents: [...], capabilities: {} } }
//   Backend → Agent: { method: "initialized" } (notification)
//
// After handshake, exposes typed methods for turn lifecycle and listens for
// canonical agent-event notifications.

import { WebSocket } from "ws";
import {
  JSONRPCServer,
  JSONRPCClient,
  JSONRPCServerAndClient,
  isJSONRPCRequest,
  isJSONRPCRequests,
  isJSONRPCResponse,
  isJSONRPCResponses,
} from "json-rpc-2.0";
import {
  AGENT_RPC_METHODS,
  AGENT_EVENT_NAMES,
  FRONTEND_RPC_METHODS,
  AgentEventSchema,
  InitializeResultSchema,
  type InitializeResult,
  type TurnStartRequest,
  type TurnStartResponse,
  type TurnCancelRequest,
  type TurnRespondRequest,
  type SessionResetRequest,
  type SessionStopRequest,
  type ProviderAuthRequest,
  type ProviderInitWorkspaceRequest,
  type ProviderContextUsageRequest,
  type ProviderUpdateModeRequest,
  type AgentEvent,
  type AgentInfo,
} from "@shared/agent-events";

// ============================================================================
// Types
// ============================================================================

export type AgentEventHandler = (event: AgentEvent) => void;

export interface AgentClientOptions {
  /** ws://127.0.0.1:{port} — the agent-server URL */
  url: string;
  /** Called for every canonical agent-event notification received from the agent-server */
  onEvent?: AgentEventHandler;
  /** Called when the connection is established and handshake completes */
  onConnected?: (agents: AgentInfo[]) => void;
  /** Called when the connection drops */
  onDisconnected?: () => void;
  /** Called when the sidecar sends a frontend-facing RPC (browser, sim, diff, plan).
   *  Must relay to the frontend and return the result. */
  onFrontendRpc?: (
    requestId: string,
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
}

// ============================================================================
// Reconnect constants
// ============================================================================

const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "1.0";

// ============================================================================
// AgentClient
// ============================================================================

export class AgentClient {
  private url: string;
  private ws: WebSocket | null = null;
  private peer: JSONRPCServerAndClient | null = null;
  private onEvent: AgentEventHandler;
  private onConnected?: (agents: AgentInfo[]) => void;
  private onDisconnected?: () => void;
  private onFrontendRpc: (
    requestId: string,
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private connected = false;

  /** Agents discovered during the initialize handshake */
  private agents: AgentInfo[] = [];

  constructor(options: AgentClientOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent ?? (() => {});
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onFrontendRpc =
      options.onFrontendRpc ??
      (() => Promise.reject(new Error("No frontend RPC handler registered")));
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /** Initiate connection to the agent-server. Auto-reconnects on drop. */
  connect(): void {
    if (this.disposed) return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }
    this.cancelReconnect();
    this.openConnection();
  }

  /** Permanently disconnect and stop reconnecting. */
  disconnect(): void {
    this.disposed = true;
    this.cancelReconnect();
    this.closeConnection();
  }

  /** Returns true if the handshake is complete and the connection is open. */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Returns the agents discovered during handshake. */
  getAgents(): ReadonlyArray<AgentInfo> {
    return this.agents;
  }

  // ---- Turn lifecycle RPCs ----

  async sendTurnStart(params: TurnStartRequest): Promise<TurnStartResponse> {
    return this.request(AGENT_RPC_METHODS.TURN_START, params) as Promise<TurnStartResponse>;
  }

  async sendTurnCancel(params: TurnCancelRequest): Promise<void> {
    await this.request(AGENT_RPC_METHODS.TURN_CANCEL, params);
  }

  async sendTurnRespond(params: TurnRespondRequest): Promise<void> {
    await this.request(AGENT_RPC_METHODS.TURN_RESPOND, params);
  }

  // ---- Session lifecycle RPCs ----

  async sendSessionReset(params: SessionResetRequest): Promise<void> {
    await this.request(AGENT_RPC_METHODS.SESSION_RESET, params);
  }

  async sendSessionStop(params: SessionStopRequest): Promise<void> {
    await this.request(AGENT_RPC_METHODS.SESSION_STOP, params);
  }

  // ---- Provider operations ----

  async sendProviderAuth(params: ProviderAuthRequest): Promise<unknown> {
    return this.request(AGENT_RPC_METHODS.PROVIDER_AUTH, params);
  }

  async sendProviderInitWorkspace(params: ProviderInitWorkspaceRequest): Promise<unknown> {
    return this.request(AGENT_RPC_METHODS.PROVIDER_INIT_WORKSPACE, params);
  }

  async sendProviderContextUsage(params: ProviderContextUsageRequest): Promise<unknown> {
    return this.request(AGENT_RPC_METHODS.PROVIDER_CONTEXT_USAGE, params);
  }

  async sendProviderUpdateMode(params: ProviderUpdateModeRequest): Promise<void> {
    this.notify(AGENT_RPC_METHODS.PROVIDER_UPDATE_MODE, params);
  }

  // ---- Introspection ----

  async listAgents(): Promise<AgentInfo[]> {
    const result = await this.request(AGENT_RPC_METHODS.AGENT_LIST, {});
    return (result as any)?.agents ?? [];
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================

  private openConnection(): void {
    if (this.disposed) return;

    console.log(`[AgentClient] Connecting to ${this.url}...`);

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error("[AgentClient] Failed to create WebSocket:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[AgentClient] WebSocket connected, starting handshake...");
      this.setupPeer();
      void this.performHandshake();
    });

    this.ws.on("message", (data: Buffer | string) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      this.handleMessage(message);
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[AgentClient] Connection closed: ${code} ${reason.toString()}`);
      this.teardownPeer();
      if (!this.disposed) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[AgentClient] WebSocket error:", err.message);
    });
  }

  private closeConnection(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "Client disconnecting");
      }
      this.ws = null;
    }
    this.teardownPeer();
  }

  // ==========================================================================
  // JSON-RPC peer
  // ==========================================================================

  private setupPeer(): void {
    const server = new JSONRPCServer({
      errorListener: (message, data) => {
        console.error("[AgentClient] RPC server error:", message, data);
      },
    });

    const client = new JSONRPCClient((payload) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("WebSocket is not open"));
      }
      try {
        this.ws.send(JSON.stringify(payload));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.peer = new JSONRPCServerAndClient(server, client, {
      errorListener: (message, data) => {
        console.error("[AgentClient] RPC client error:", message, data);
      },
    });

    // Register handlers for all agent-event notification methods.
    // The agent-server sends these as JSON-RPC notifications (no id).
    for (const eventName of Object.values(AGENT_EVENT_NAMES)) {
      this.peer.addMethod(eventName, async (params) => {
        this.dispatchEvent(eventName, params);
        return undefined; // notifications don't return a value
      });
    }

    // Register handlers for frontend-facing RPC methods.
    // The sidecar's tools (browser, simulator, workspace) call these as
    // JSON-RPC requests through the tunnel. We relay them to the frontend
    // via tool-relay, which broadcasts a q:event tool:request and waits
    // for the frontend's q:tool_response.
    const frontendMethods = Object.values(FRONTEND_RPC_METHODS);
    for (const method of frontendMethods) {
      this.peer.addMethod(method, async (params: any) => {
        const requestId = crypto.randomUUID();
        const sessionId = params?.sessionId ?? "unknown";
        console.log(
          `[AgentClient] Frontend RPC: method=${method} requestId=${requestId} session=${sessionId}`
        );
        const result = await this.onFrontendRpc(requestId, sessionId, method, params ?? {});
        return result;
      });
    }
    console.log(`[AgentClient] Registered ${frontendMethods.length} frontend RPC methods`);
  }

  private teardownPeer(): void {
    const wasConnected = this.connected;
    this.connected = false;
    if (this.peer) {
      this.peer.rejectAllPendingRequests("Connection closed");
      this.peer = null;
    }
    if (wasConnected) {
      this.onDisconnected?.();
    }
  }

  private dispatchEvent(eventName: string, params: unknown): void {
    // Validate and normalize the event payload using the canonical schema.
    // If parsing fails, log and skip — don't crash the client.
    const parsed = AgentEventSchema.safeParse(params);
    if (!parsed.success) {
      console.error(
        `[AgentClient] Invalid event payload for "${eventName}":`,
        parsed.error.message
      );
      return;
    }
    try {
      this.onEvent(parsed.data);
    } catch (err) {
      console.error(`[AgentClient] Event handler threw for "${eventName}":`, err);
    }
  }

  // ==========================================================================
  // Handshake
  // ==========================================================================

  private async performHandshake(): Promise<void> {
    if (!this.peer) return;

    try {
      const rawResult = await this.withTimeout(
        this.peer.request(AGENT_RPC_METHODS.INITIALIZE, {
          version: PROTOCOL_VERSION,
          capabilities: {},
        }),
        HANDSHAKE_TIMEOUT_MS,
        "initialize"
      );

      const parsed = InitializeResultSchema.safeParse(rawResult);
      if (!parsed.success) {
        throw new Error(`Invalid initialize response: ${parsed.error.message}`);
      }
      const result: InitializeResult = parsed.data;

      if (result.version !== PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported protocol version "${result.version}" (expected "${PROTOCOL_VERSION}")`
        );
      }

      this.agents = result.agents;
      console.log(
        `[AgentClient] Handshake complete: version=${result.version} agents=[${this.agents.map((a) => a.type).join(", ")}]`
      );

      // Send "initialized" notification (fire-and-forget)
      this.peer.notify(AGENT_RPC_METHODS.INITIALIZED, {}, undefined);

      this.connected = true;
      this.reconnectAttempt = 0;
      this.onConnected?.(this.agents);
    } catch (err) {
      console.error("[AgentClient] Handshake failed:", err);
      // Close and reconnect
      this.closeConnection();
      if (!this.disposed) this.scheduleReconnect();
    }
  }

  // ==========================================================================
  // Message dispatch
  // ==========================================================================

  private handleMessage(message: string): void {
    if (!this.peer) return;

    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch {
      console.error("[AgentClient] Failed to parse JSON:", message.slice(0, 200));
      return;
    }

    if (!isJsonRpcPayload(payload)) {
      console.error("[AgentClient] Received non-JSON-RPC payload");
      return;
    }

    void this.peer.receiveAndSend(payload, undefined, undefined).catch((e) => {
      console.error("[AgentClient] Failed to handle message:", e);
    });
  }

  // ==========================================================================
  // Outbound helpers
  // ==========================================================================

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.peer || !this.connected) {
      return Promise.reject(new Error(`AgentClient is not connected (method=${method})`));
    }
    return Promise.resolve(this.peer.request(method, params, undefined));
  }

  private notify(method: string, params: unknown): void {
    if (!this.peer || !this.connected) {
      console.error(`[AgentClient] Cannot send notification "${method}" — not connected`);
      return;
    }
    this.peer.notify(method, params, undefined);
  }

  // ==========================================================================
  // Reconnect
  // ==========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;
    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt++;
    console.log(`[AgentClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`[AgentClient] ${label} timed out after ${ms}ms`));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
    });
  }
}

// ============================================================================
// JSON-RPC payload type guard
// ============================================================================

function isJsonRpcPayload(payload: unknown): boolean {
  return (
    isJSONRPCRequest(payload) ||
    isJSONRPCRequests(payload) ||
    isJSONRPCResponse(payload) ||
    isJSONRPCResponses(payload)
  );
}
