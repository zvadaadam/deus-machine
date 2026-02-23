// gateway/clients/sidecar.ts
// JSON-RPC 2.0 client that connects to the sidecar Unix domain socket.
// Receives agent notifications (messages, errors) and handles bidirectional
// RPC (auto-approves askUserQuestion, exitPlanMode in gateway mode).

import * as net from "net";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import type { AgentMessageNotification, AgentErrorNotification } from "../types";

// JSON-RPC 2.0 message types
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest | JsonRpcResponse;

/** Events emitted by SidecarClient */
export interface SidecarClientEvents {
  message: [AgentMessageNotification];
  error: [AgentErrorNotification];
  enterPlanMode: [{ type: string; id: string; agentType: string }];
  connected: [];
  disconnected: [];
}

export class SidecarClient extends EventEmitter {
  private socketPath: string;
  private socket: net.Socket | null = null;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  /** Connect to the sidecar socket */
  connect(): void {
    if (this.socket) return;

    this.socket = net.createConnection(this.socketPath, () => {
      console.log("[SidecarClient] Connected to sidecar");
      this.reconnectDelay = 1000; // Reset backoff
      this.emit("connected");
    });

    this.socket.on("data", (data) => {
      this.buffer += this.decoder.write(data);
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) this.handleLine(line);
      }
    });

    this.socket.on("error", (err) => {
      console.error("[SidecarClient] Socket error:", err.message);
    });

    this.socket.on("close", () => {
      console.log("[SidecarClient] Disconnected from sidecar");
      this.socket = null;
      this.buffer = "";
      this.rejectAllPending("Socket closed");
      this.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  /** Disconnect and stop reconnecting */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.rejectAllPending("Client disconnected");
  }

  /** Send a JSON-RPC notification to the sidecar (fire-and-forget) */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Send a JSON-RPC request and wait for a response */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a query notification to the sidecar to trigger an agent */
  sendQuery(
    sessionId: string,
    prompt: string,
    options: {
      cwd: string;
      agentType?: string;
      model?: string;
      permissionMode?: string;
    }
  ): void {
    this.notify("query", {
      type: "query",
      id: sessionId,
      agentType: options.agentType ?? "claude",
      prompt,
      options: {
        cwd: options.cwd,
        model: options.model,
        permissionMode: options.permissionMode ?? "default",
      },
    });
  }

  /** Send a cancel notification to stop an agent */
  sendCancel(sessionId: string, agentType = "claude"): void {
    this.notify("cancel", {
      type: "cancel",
      id: sessionId,
      agentType,
    });
  }

  /** Whether the client is currently connected */
  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // ---- Internal ----

  private send(msg: JsonRpcMessage): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("[SidecarClient] Not connected");
    }
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[SidecarClient] Failed to parse JSON:", line.slice(0, 100));
      return;
    }

    // Response to a pending request
    if ("id" in msg && !("method" in msg)) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        this.pendingRequests.delete(msg.id as number);
        const resp = msg as JsonRpcResponse;
        if (resp.error) {
          pending.reject(new Error(resp.error.message));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Request from sidecar (bidirectional RPC) — auto-approve in gateway mode
    if ("id" in msg && "method" in msg) {
      this.handleSidecarRequest(msg as JsonRpcRequest);
      return;
    }

    // Notification from sidecar
    if ("method" in msg && !("id" in msg)) {
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  /** Handle bidirectional RPC requests from the sidecar.
   *  In gateway mode, auto-approve most requests. */
  private handleSidecarRequest(req: JsonRpcRequest): void {
    const respond = (result: unknown) => {
      this.send({ jsonrpc: "2.0", id: req.id, result });
    };

    const respondError = (code: number, message: string) => {
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code, message },
      } as any);
    };

    switch (req.method) {
      case "askUserQuestion": {
        // Auto-select the first option for each question
        const params = req.params as { questions?: Array<{ options: string[] }> } | undefined;
        const answers = params?.questions?.map((q) => q.options[0] ?? "yes") ?? ["yes"];
        respond({ answers });
        break;
      }

      case "exitPlanMode":
        // Auto-approve plan mode exit
        respond({ approved: true });
        break;

      case "getDiff":
        // Return empty diff — gateway doesn't have direct file access
        respond({ diff: "", error: undefined });
        break;

      case "diffComment":
        respond({ success: true });
        break;

      case "getTerminalOutput":
        // No terminal access from gateway
        respond({ output: "", source: "none", isRunning: false });
        break;

      // Browser automation methods — not available via gateway
      case "browserSnapshot":
      case "browserClick":
      case "browserType":
      case "browserNavigate":
      case "browserGetState":
      case "browserWaitFor":
      case "browserEvaluate":
      case "browserPressKey":
      case "browserHover":
      case "browserSelectOption":
      case "browserNavigateBack":
      case "browserConsoleMessages":
      case "browserNetworkRequests":
      case "browserScreenshot":
      case "browserScroll":
        respondError(-32601, "Browser automation not available via messaging gateway");
        break;

      default:
        respondError(-32601, `Method not found: ${req.method}`);
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case "message":
        this.emit("message", notif.params as AgentMessageNotification);
        break;
      case "queryError":
        this.emit("error", notif.params as AgentErrorNotification);
        break;
      case "enterPlanModeNotification":
        this.emit("enterPlanMode", notif.params);
        break;
      default:
        console.debug("[SidecarClient] Unknown notification:", notif.method);
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    console.log(`[SidecarClient] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
