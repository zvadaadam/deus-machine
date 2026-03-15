// sidecar/index.ts
// Entry point for the OpenDevs agent-server process.
//
// Supports two transport modes (selected via --listen flag):
//   --listen ws://    → WebSocket server on 127.0.0.1 (default, dynamic port)
//   --listen unix://  → Unix domain socket (legacy, for backward compat)
//
// Both transports use JSON-RPC 2.0 over text frames/lines.

import * as Sentry from "@sentry/node";

// Initialize Sentry before anything else.
// DSN passed as env var from Rust process manager (not hardcoded — open source repo).
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    sendDefaultPii: true,
    initialScope: { tags: { process: "sidecar" } },
  });
}

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as util from "util";
import { exec } from "child_process";
import { StringDecoder } from "string_decoder";
import { createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

import { getErrorMessage } from "../shared/lib/errors";
import { RpcConnection, wsTransport } from "./rpc-connection";
import { FrontendClient } from "./frontend-client";
import { classifyError } from "./agents/error-classifier";
import { registerAgent, getAgent, initializeAllAgents } from "./agents/agent-handler";
import { ClaudeAgentHandler } from "./agents/claude/claude-handler";
import { CodexAgentHandler } from "./agents/codex/codex-handler";

// ============================================================================
// Logging
// ============================================================================

export const logFilePath = `/tmp/opendevs-${process.pid}.log`;
const originalLog = console.log;

const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as "debug" | "info" | "error";
const LOG_LEVELS = { debug: 0, info: 1, error: 2 };

function shouldLog(level: "debug" | "info" | "error"): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function formatLogArgs(args: any[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack || ""}`;
      return util.inspect(arg, { depth: 4, breakLength: Infinity });
    })
    .join(" ");
}

// Buffered log writer -- avoids synchronous appendFileSync on every log call
let logBuffer = "";
let flushTimer: NodeJS.Timeout | null = null;

function flushLogs(): void {
  if (logBuffer) {
    fs.appendFileSync(logFilePath, logBuffer);
    logBuffer = "";
  }
  flushTimer = null;
}

function writeLog(line: string): void {
  logBuffer += line;
  if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, 100);
  }
  if (logBuffer.length > 8192) {
    flushLogs();
  }
}

// Ensure logs are flushed on shutdown
process.on("exit", flushLogs);

console.log = (...args: any[]) => {
  if (!shouldLog("info")) return;
  const timestamp = new Date().toISOString();
  writeLog(`[${timestamp}] ${formatLogArgs(args)}\n`);
};

console.error = (...args: any[]) => {
  const timestamp = new Date().toISOString();
  writeLog(`[${timestamp}] ERROR: ${formatLogArgs(args)}\n`);
};

console.debug = (...args: any[]) => {
  if (!shouldLog("debug")) return;
  const timestamp = new Date().toISOString();
  writeLog(`[${timestamp}] DEBUG: ${formatLogArgs(args)}\n`);
};

// ============================================================================
// CLI flag parsing
// ============================================================================

type TransportMode = "ws" | "unix";

function parseTransportMode(): TransportMode {
  const listenIdx = process.argv.indexOf("--listen");
  if (listenIdx === -1) return "ws"; // Default: WebSocket
  const value = process.argv[listenIdx + 1] || "";
  if (value.startsWith("unix://")) return "unix";
  if (value.startsWith("ws://") || value === "") return "ws";
  // Unknown scheme — default to ws
  console.error(`[CLI] Unknown --listen scheme "${value}", defaulting to ws://`);
  return "ws";
}

// ============================================================================
// UnifiedSidecar
// ============================================================================

class UnifiedSidecar {
  private transportMode: TransportMode;

  // Unix socket transport
  private socketPath: string;
  private unixServer: net.Server | null = null;

  // WebSocket transport
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wss: WebSocketServer | null = null;

  constructor(mode: TransportMode) {
    this.transportMode = mode;
    this.socketPath = path.join(os.tmpdir(), `opendevs-sidecar-${process.pid}.sock`);

    console.log(`UnifiedSidecar: Initializing (transport=${mode})...`);

    // Graceful shutdown handlers
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n[SIGNAL] Received ${signal}, shutting down gracefully...`);
      try {
        await this.cleanup();
        console.log("[SIGNAL] Cleanup complete, exiting process");
      } catch (error) {
        console.error("[SIGNAL] Cleanup failed:", error);
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  }

  /**
   * Wires up all JSON-RPC methods and notifications on a new connection.
   * Transport-agnostic — works with both Unix socket and WebSocket tunnels.
   */
  private setupJsonRpc(rpcTunnel: RpcConnection): void {
    FrontendClient.attachTunnel(rpcTunnel);

    // --- Query (dispatch to agent by agentType) ---
    // Returns synchronous ACK/reject before async streaming begins.
    // query() is NOT awaited — the ACK returns immediately after validation.
    FrontendClient.onQuery(rpcTunnel, async (request) => {
      const tQueryReceived = Date.now();
      console.log(
        `[TIMING][QUERY] RECEIVED session=${request.id} agent=${request.agentType} promptLength=${request.prompt?.length ?? 0}`
      );
      const agent = getAgent(request.agentType);
      if (!agent) {
        return { accepted: false, reason: `No agent registered for type: ${request.agentType}` };
      }

      // The backend saves the user message BEFORE forwarding turn/start to the
      // agent-server. The agent-server just receives the query and starts the SDK.
      agent.query(request.id, request.prompt, request.options).catch((err) => {
        console.error(`[QUERY] Unhandled error in ${request.agentType} query:`, err);
        // Recover: notify frontend of the error. The backend handles DB status updates
        // via canonical events (session.error).
        const classified = classifyError(err);
        FrontendClient.sendError({
          id: request.id,
          type: "error",
          error: classified.message,
          agentType: request.agentType,
          category: classified.category,
        });
        FrontendClient.emitSessionError(
          request.id,
          request.agentType,
          classified.message,
          classified.category
        );
      });

      // Dual-write: emit canonical session.started event after dispatch
      FrontendClient.emitSessionStarted(request.id, request.agentType);

      console.log(
        `[TIMING][QUERY] DISPATCHED session=${request.id} dispatchTime=${Date.now() - tQueryReceived}ms`
      );
      return { accepted: true };
    });

    // --- Cancel (dispatch to agent by agentType) ---
    FrontendClient.onCancel(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (agent) void agent.cancel(request.id);
    });

    // --- Auth check (dispatched by agentType) ---
    FrontendClient.onClaudeAuth(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (!agent?.auth) {
        return Promise.reject(new Error(`Agent "${request.agentType}" does not support auth`));
      }
      return agent.auth({ id: request.id, cwd: request.options.cwd });
    });

    // --- Workspace init (dispatched by agentType) ---
    FrontendClient.onWorkspaceInit(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (!agent?.initWorkspace) {
        return Promise.reject(
          new Error(`Agent "${request.agentType}" does not support workspace init`)
        );
      }
      return agent.initWorkspace({
        id: request.id,
        cwd: request.options.cwd,
        ghToken: request.options.ghToken,
        claudeEnvVars: request.options.claudeEnvVars,
      });
    });

    // --- Context usage (dispatched by agentType) ---
    FrontendClient.onContextUsage(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (!agent?.getContextUsage) {
        return Promise.reject(
          new Error(`Agent "${request.agentType}" does not support context usage`)
        );
      }
      return agent.getContextUsage(request);
    });

    // --- Permission mode updates (dispatched by agentType) ---
    // Fire-and-forget notification — no error if the agent doesn't support it
    FrontendClient.onUpdatePermissionMode(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (agent?.updatePermissionMode) {
        void agent.updatePermissionMode(request.id, request.permissionMode);
      }
    });

    // --- Reset generator (dispatch to agent by agentType) ---
    FrontendClient.onResetGenerator(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (agent) agent.reset(request.id);
    });
  }

  // ==========================================================================
  // Unix socket transport
  // ==========================================================================

  /**
   * Handles a new TCP/Unix socket connection.
   * Sets up line-based JSON-RPC message framing.
   */
  private handleUnixConnection(socket: net.Socket): void {
    console.log("Client connected (unix)");
    const rpcTunnel = new RpcConnection(socket);
    this.setupJsonRpc(rpcTunnel);

    let buffer = "";
    const decoder = new StringDecoder("utf8");

    socket.on("data", (data) => {
      buffer += decoder.write(data);
      console.debug("Received data with length", data.length);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          rpcTunnel.handleLine(line);
        }
      }
    });

    socket.on("error", (error: any) => {
      console.error("Socket error:", error);
    });

    socket.on("close", (hadError) => {
      console.log(`Client disconnected (unix), hadError: ${hadError}`);
      rpcTunnel.stop();
      FrontendClient.detachTunnel(rpcTunnel);
    });
  }

  // ==========================================================================
  // WebSocket transport
  // ==========================================================================

  /**
   * Handles a new WebSocket connection.
   * Each WS text frame is a complete JSON-RPC message (no line splitting needed).
   */
  private handleWsConnection(ws: WebSocket): void {
    console.log("Client connected (ws)");
    const transport = wsTransport(ws);
    const rpcTunnel = new RpcConnection(transport);
    this.setupJsonRpc(rpcTunnel);

    ws.on("message", (data: Buffer | string) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      console.debug("Received WS message with length", message.length);
      rpcTunnel.handleMessage(message);
    });

    ws.on("error", (error: Error) => {
      console.error("WebSocket error:", error);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`Client disconnected (ws), code=${code} reason=${reason.toString()}`);
      rpcTunnel.stop();
      FrontendClient.detachTunnel(rpcTunnel);
    });
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Kills any remaining Claude child processes spawned by this sidecar.
   */
  private async killRemainingChildProcesses(): Promise<void> {
    return new Promise((resolve) => {
      const command = `/usr/bin/pgrep -P ${process.pid}`;
      exec(command, (error, stdout) => {
        if (error) {
          console.log("[CLEANUP] No child processes found");
          resolve();
          return;
        }
        const childPids = stdout
          .trim()
          .split("\n")
          .filter((pid) => pid);
        if (childPids.length === 0) {
          console.log("[CLEANUP] No child processes to kill");
          resolve();
          return;
        }
        console.log(`[CLEANUP] Found ${childPids.length} child processes: ${childPids.join(", ")}`);
        childPids.forEach((pid) => {
          try {
            process.kill(Number(pid), "SIGTERM");
            console.log(`[CLEANUP] Sent SIGTERM to child PID ${pid}`);
          } catch (e) {
            const errorMsg = getErrorMessage(e);
            console.log(`[CLEANUP] Failed to kill child PID ${pid}: ${errorMsg}`);
          }
        });
        resolve();
      });
    });
  }

  private async cleanup(): Promise<void> {
    await this.killRemainingChildProcesses();

    // Clean up Unix socket
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
      console.log("[CLEANUP] Removed socket file");
    }
    if (this.unixServer) {
      this.unixServer.close();
    }

    // Clean up WebSocket server
    if (this.wss) {
      // Close all connected clients
      for (const client of this.wss.clients) {
        client.close(1001, "Server shutting down");
      }
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
    }
  }

  /**
   * Starts the agent-server:
   * 1. Clean up stale resources
   * 2. Initialize agent handlers
   * 3. Listen on the selected transport
   * 4. Print connection info to stdout (consumed by the Rust process manager)
   */
  async start(): Promise<void> {
    await this.cleanup();

    // Register all agent handlers
    registerAgent(new ClaudeAgentHandler());
    registerAgent(new CodexAgentHandler());

    // Initialize all registered agents
    console.log("Initializing agent handlers...");
    const initResults = initializeAllAgents();
    for (const [agentType, result] of initResults) {
      if (!result.success) {
        console.error(`${agentType} initialization failed:`, result.error);
      } else {
        console.log(`${agentType} handler initialized successfully`);
      }
    }

    if (this.transportMode === "ws") {
      return this.startWebSocket();
    } else {
      return this.startUnixSocket();
    }
  }

  private startWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create a minimal HTTP server just for the WS upgrade.
      // Binding to 127.0.0.1 — agent-server only accepts local connections.
      this.httpServer = createHttpServer((_req, res) => {
        // Reject plain HTTP requests — this server only does WebSocket upgrades.
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on("connection", (ws) => {
        console.log("Server: New WebSocket connection accepted");
        this.handleWsConnection(ws);
      });

      this.wss.on("error", (error: Error) => {
        console.error("WebSocketServer error:", error);
      });

      // Port 0 = OS-assigned dynamic port
      this.httpServer.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;

        console.log(`Agent-server listening on ws://127.0.0.1:${port}`);
        console.log(`Sidecar PID: ${process.pid}`);

        // Machine-readable output for the Rust process manager.
        // LISTEN_URL is the new canonical output; SOCKET_PATH kept for transition.
        originalLog(`LISTEN_URL=ws://127.0.0.1:${port}`);
        resolve();
      });

      this.httpServer.on("error", (error: Error) => {
        console.error("HTTP server error:", error);
        reject(error);
      });
    });
  }

  private startUnixSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.unixServer = net.createServer((socket) => {
        console.log("Server: New connection accepted");
        this.handleUnixConnection(socket);
      });

      this.unixServer.listen(this.socketPath, () => {
        console.log(`Unified sidecar listening on ${this.socketPath}`);
        console.log(`Sidecar PID: ${process.pid}`);

        // Print the socket path to stdout so the OpenDevs app can connect
        originalLog(`SOCKET_PATH=${this.socketPath}`);
        resolve();
      });

      this.unixServer.on("error", (error: any) => {
        console.error("Server error:", error);
        reject(error);
      });
    });
  }
}

// ============================================================================
// Global error handlers
// ============================================================================

process.on("uncaughtException", (error: any) => {
  console.error("Uncaught Exception:", error.message);
  if (error.stack) console.error("Stack:", error.stack);
  Sentry.captureException(error);
  Sentry.close(2000).finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason, _promise) => {
  // Sentry's built-in onUnhandledRejectionIntegration captures and normalizes
  // rejection reasons automatically. We only log here for local visibility.
  if (reason instanceof Error) {
    console.error("Unhandled Rejection:", reason.message);
    if (reason.stack) console.error("Stack:", reason.stack);
  }
  console.error("Unhandled Rejection Reason:", JSON.stringify(reason, null, 2));
});

// ============================================================================
// Bootstrap
// ============================================================================

const mode = parseTransportMode();
const sidecar = new UnifiedSidecar(mode);
sidecar.start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
