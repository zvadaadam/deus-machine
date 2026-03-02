// sidecar/index.ts
// Entry point for the OpenDevs sidecar v2 process.
// Creates a Unix domain socket server that the OpenDevs frontend connects to
// via newline-delimited JSON-RPC 2.0.

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

import { RpcConnection } from "./rpc-connection";
import { FrontendClient } from "./frontend-client";
import { closeDatabase } from "./db/index";
import { reconcileStuckSessions } from "./db/session-writer";
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
// UnifiedSidecar
// ============================================================================

class UnifiedSidecar {
  private socketPath: string;
  private server: net.Server;

  constructor() {
    console.log("UnifiedSidecar: Initializing...");

    this.socketPath = path.join(os.tmpdir(), `opendevs-sidecar-${process.pid}.sock`);

    this.server = net.createServer((socket) => {
      console.log("Server: New connection accepted");
      this.handleConnection(socket);
    });

    // Graceful shutdown handlers
    process.on("SIGINT", async () => {
      console.log("\n[SIGNAL] Received SIGINT, shutting down gracefully...");
      try {
        await this.cleanup();
        console.log("[SIGNAL] Cleanup complete, exiting process");
      } catch (error) {
        console.error("[SIGNAL] Cleanup failed:", error);
      } finally {
        process.exit(0);
      }
    });

    process.on("SIGTERM", async () => {
      console.log("\n[SIGNAL] Received SIGTERM, shutting down gracefully...");
      try {
        await this.cleanup();
        console.log("[SIGNAL] Cleanup complete, exiting process");
      } catch (error) {
        console.error("[SIGNAL] Cleanup failed:", error);
      } finally {
        process.exit(0);
      }
    });
  }

  /**
   * Wires up all JSON-RPC methods and notifications on a new connection.
   */
  private setupJsonRpc(rpcTunnel: RpcConnection, socket: net.Socket): void {
    FrontendClient.attachTunnel(rpcTunnel);

    // --- Query (dispatch to agent by agentType) ---
    // Returns synchronous ACK/reject before async streaming begins.
    // handleQuery is NOT awaited — the ACK returns immediately after validation.
    FrontendClient.onQuery(async (request) => {
      const tQueryReceived = Date.now();
      console.log(`[TIMING][QUERY] RECEIVED session=${request.id} agent=${request.agentType} prompt=${request.prompt?.slice(0, 80)}...`);
      const agent = getAgent(request.agentType);
      if (!agent) {
        return { accepted: false, reason: `No agent registered for type: ${request.agentType}` };
      }
      agent.handleQuery(request.id, request.prompt, request.options).catch((err) => {
        console.error(`[QUERY] Unhandled error in ${request.agentType} handleQuery:`, err);
      });
      console.log(`[TIMING][QUERY] DISPATCHED session=${request.id} dispatchTime=${Date.now() - tQueryReceived}ms`);
      return { accepted: true };
    });

    // --- Cancel (dispatch to agent by agentType) ---
    FrontendClient.onCancel(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (agent) void agent.handleCancel(request.id);
    });

    // --- Auth check (Claude-specific RPC) ---
    FrontendClient.onClaudeAuth(rpcTunnel, (request) => {
      const claude = getAgent("claude") as ClaudeAgentHandler;
      return claude.claudeAuth({ id: request.id, cwd: request.options.cwd });
    });

    // --- Workspace init (Claude-specific RPC) ---
    FrontendClient.onWorkspaceInit(rpcTunnel, (request) => {
      const claude = getAgent("claude") as ClaudeAgentHandler;
      return claude.workspaceInit({
        id: request.id,
        cwd: request.options.cwd,
        ghToken: request.options.ghToken,
        claudeEnvVars: request.options.claudeEnvVars,
      });
    });

    // --- Context usage (Claude-specific RPC) ---
    FrontendClient.onContextUsage(rpcTunnel, (request) => {
      const claude = getAgent("claude") as ClaudeAgentHandler;
      return claude.getContextUsage(request);
    });

    // --- Permission mode updates (Claude-specific) ---
    FrontendClient.onUpdatePermissionMode(rpcTunnel, (request) => {
      const claude = getAgent("claude") as ClaudeAgentHandler;
      if (claude) void claude.updatePermissionMode(request.id, request.permissionMode);
    });

    // --- Reset generator (dispatch to agent by agentType) ---
    FrontendClient.onResetGenerator(rpcTunnel, (request) => {
      const agent = getAgent(request.agentType);
      if (agent) agent.handleReset(request.id);
    });

    // Note: socket "close" handler is in handleConnection() which also calls
    // rpcTunnel.stop() and FrontendClient.detachTunnel(). No need for a
    // duplicate handler here.
  }

  /**
   * Handles a new TCP/Unix socket connection.
   * Sets up line-based JSON-RPC message framing.
   */
  private handleConnection(socket: net.Socket): void {
    console.log("Client connected");
    const rpcTunnel = new RpcConnection(socket);
    this.setupJsonRpc(rpcTunnel, socket);

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
      console.log(`Client disconnected, hadError: ${hadError}`);
      rpcTunnel.stop();
      FrontendClient.detachTunnel(rpcTunnel);
    });
  }

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
            const errorMsg = e instanceof Error ? e.message : String(e);
            console.log(`[CLEANUP] Failed to kill child PID ${pid}: ${errorMsg}`);
          }
        });
        resolve();
      });
    });
  }

  private async cleanup(): Promise<void> {
    await this.killRemainingChildProcesses();
    try {
      closeDatabase();
    } catch (err) {
      console.error("[CLEANUP] Failed to close database:", err);
    }
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
      console.log("[CLEANUP] Removed socket file");
    }
    this.server.close();
  }

  /**
   * Starts the sidecar:
   * 1. Clean up stale socket
   * 2. Initialize the Claude handler (verify executable)
   * 3. Listen on Unix domain socket
   * 4. Print SOCKET_PATH=<path> to stdout (consumed by the OpenDevs app)
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

    // Reset sessions stuck in "working" status from a previous sidecar lifecycle.
    // Must run after DB is initialized (getDatabase auto-inits) but before
    // accepting connections, so no race with incoming queries.
    const reconcileResult = reconcileStuckSessions();
    if (!reconcileResult.ok) {
      console.error(`Failed to reconcile stuck sessions: ${reconcileResult.error}`);
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, () => {
        console.log(`Unified sidecar listening on ${this.socketPath}`);
        console.log(`Sidecar PID: ${process.pid}`);

        // Print the socket path to stdout so the OpenDevs app can connect
        originalLog(`SOCKET_PATH=${this.socketPath}`);
        resolve();
      });

      this.server.on("error", (error: any) => {
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

const sidecar = new UnifiedSidecar();
sidecar.start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
