// agent-server/index.ts
// Entry point for the Deus agent-server process.
//
// WebSocket server on 127.0.0.1 (dynamic port) using JSON-RPC 2.0 text frames.

import * as Sentry from "@sentry/node";

// Initialize Sentry before anything else.
// DSN is a public, write-only ingest token — safe to hardcode.
Sentry.init({
  dsn: "https://7d01f9d51458e372a7e6f48649842653@o4510970844020736.ingest.us.sentry.io/4510971283898368",
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  sendDefaultPii: true,
  initialScope: { tags: { process: "agent-server" } },
});

import * as fs from "fs";
import * as util from "util";
import { exec } from "child_process";
import { createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

import { getErrorMessage } from "@shared/lib/errors";
import { RpcConnection, wsTransport } from "./rpc-connection";
import { EventBroadcaster } from "./event-broadcaster";
import { classifyError } from "./agents/lifecycle";
import { registerAgent, getAgent, initializeAllAgents } from "./agents/registry";
import { ClaudeAgentHandler } from "./agents/claude/claude-handler";
import { CodexAgentHandler } from "./agents/codex/codex-handler";
import {
  handleHttpRequest,
  isShuttingDown,
  setShuttingDown,
  setAgentsInitialized,
  trackSession,
  untrackSession,
  waitForDrain,
  cancelRemainingSessions,
} from "./health";

// ============================================================================
// Logging
// ============================================================================

export const logFilePath = `/tmp/deus-${process.pid}.log`;
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
  const formatted = formatLogArgs(args);
  writeLog(`[${timestamp}] ERROR: ${formatted}\n`);
  // Also write to real stderr so the backend child-process handler can
  // capture and forward these lines to the Electron terminal.
  // Without this, console.error() from bundled libraries (e.g. screen-studio)
  // only lands in the log file and is invisible in the dev console.
  process.stderr.write(`${formatted}\n`);
};

console.debug = (...args: any[]) => {
  if (!shouldLog("debug")) return;
  const timestamp = new Date().toISOString();
  writeLog(`[${timestamp}] DEBUG: ${formatLogArgs(args)}\n`);
};

// ============================================================================
// AgentServer
// ============================================================================

class AgentServer {
  private initializedAgents = new Set<string>();
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wss: WebSocketServer | null = null;

  constructor() {
    console.log("AgentServer: Initializing...");

    // Graceful shutdown handlers — drain in-flight turns before exiting
    const gracefulShutdown = async (signal: string) => {
      console.log(`\n[SIGNAL] Received ${signal}, shutting down gracefully...`);

      // 1. Stop accepting new turn/start requests
      setShuttingDown(true);

      // 2. Stop accepting new WS connections (close the HTTP listener)
      if (this.httpServer) {
        this.httpServer.close();
        console.log("[SHUTDOWN] HTTP server closed to new connections");
      }

      // 3. Wait for in-flight turns to drain (default 30s timeout)
      console.log("[SHUTDOWN] Waiting for in-flight turns to drain...");
      const drained = await waitForDrain();
      if (drained) {
        console.log("[SHUTDOWN] All turns drained successfully");
      } else {
        console.log("[SHUTDOWN] Drain timeout reached, cancelling remaining sessions");
        await cancelRemainingSessions();
      }

      // 4. Full cleanup (kill child processes, close WS clients)
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

  private getInitializedAgents() {
    const agents: { type: string; capabilities: unknown; initialized: boolean }[] = [];
    for (const [agentType, handler] of [
      ["claude", getAgent("claude")],
      ["codex", getAgent("codex")],
    ] as const) {
      if (handler && this.initializedAgents.has(agentType)) {
        agents.push({ type: agentType, capabilities: handler.capabilities, initialized: true });
      }
    }
    return agents;
  }

  /**
   * Wires up all JSON-RPC methods and notifications on a new connection.
   */
  private setupJsonRpc(rpcTunnel: RpcConnection): void {
    EventBroadcaster.attachTunnel(rpcTunnel);

    // --- Initialize handshake (backend agent-client sends this) ---
    rpcTunnel.addMethod("initialize", () => ({
      version: "1.0",
      agents: this.getInitializedAgents(),
    }));

    // --- Initialized notification (backend confirms handshake) ---
    rpcTunnel.addMethod("initialized", () => {
      console.log("[RPC] Backend handshake complete (initialized)");
      return undefined;
    });

    // --- turn/start (new wire protocol method, maps to query dispatch) ---
    rpcTunnel.addMethod("turn/start", async (params: any) => {
      const sessionId = params?.sessionId;
      const agentType = params?.agentType || "claude";
      const prompt = params?.prompt;
      const options = params?.options || {};

      // Reject new turns during shutdown
      if (isShuttingDown()) {
        return { accepted: false, reason: "shutting down" };
      }

      if (!sessionId || !prompt) {
        return { accepted: false, reason: "turn/start requires sessionId and prompt" };
      }

      const agent = getAgent(agentType);
      if (!agent) {
        return { accepted: false, reason: `No agent registered for type: ${agentType}` };
      }

      // Track this session for graceful shutdown draining
      trackSession(sessionId, agentType);

      agent
        .query(sessionId, prompt, options)
        .catch((err) => {
          console.error(`[turn/start] Unhandled error in ${agentType} query:`, err);
          const classified = classifyError(err);
          EventBroadcaster.sendError({
            id: sessionId,
            type: "error",
            error: classified.message,
            agentType,
            category: classified.category,
          });
          EventBroadcaster.emitSessionError(
            sessionId,
            agentType,
            classified.message,
            classified.category
          );
        })
        .finally(() => {
          // Untrack when the turn completes (success, error, or cancel)
          untrackSession(sessionId);
        });

      EventBroadcaster.emitSessionStarted(sessionId, agentType);

      console.log(`[TIMING][turn/start] DISPATCHED session=${sessionId}`);
      return { accepted: true };
    });

    // --- turn/respond (tool relay response from backend) ---
    // Currently a stub: the agent-server tools use direct JSON-RPC requests
    // (EventBroadcaster.requestBrowserXxx) rather than the canonical
    // tool.request notification path. When tools migrate to the canonical
    // path, this handler will resolve pending promises by requestId.
    rpcTunnel.addMethod("turn/respond", (params: any) => {
      const { requestId } = params ?? {};
      console.log(`[AgentServer] turn/respond received (requestId=${requestId})`);
    });

    // --- turn/cancel & session/stop both cancel across all agents ---
    const cancelAll = async (params: any) => {
      const sessionId = params?.sessionId;
      if (!sessionId) return;
      for (const agentType of ["claude", "codex"] as const) {
        const agent = getAgent(agentType);
        if (agent) void agent.cancel(sessionId);
      }
    };
    rpcTunnel.addMethod("turn/cancel", cancelAll);
    rpcTunnel.addMethod("session/stop", cancelAll);

    // --- session/reset (new wire protocol method) ---
    rpcTunnel.addMethod("session/reset", (params: any) => {
      const sessionId = params?.sessionId;
      if (!sessionId) return;
      for (const agentType of ["claude", "codex"] as const) {
        const agent = getAgent(agentType);
        if (agent) agent.reset(sessionId);
      }
    });

    // --- provider/auth (check agent authentication) ---
    rpcTunnel.addMethod("provider/auth", async (params: any) => {
      const agentType = params?.agentType || "claude";
      const agent = getAgent(agentType);
      if (!agent?.auth) throw new Error(`Agent "${agentType}" does not support auth`);
      return agent.auth({ cwd: params?.cwd });
    });

    // --- provider/initWorkspace (slash commands, MCP servers) ---
    rpcTunnel.addMethod("provider/initWorkspace", async (params: any) => {
      const agentType = params?.agentType || "claude";
      const agent = getAgent(agentType);
      if (!agent?.initWorkspace)
        throw new Error(`Agent "${agentType}" does not support workspace init`);
      return agent.initWorkspace({
        cwd: params?.cwd,
        ghToken: params?.ghToken,
        providerEnvVars: params?.providerEnvVars,
      });
    });

    // --- provider/contextUsage (token usage stats) ---
    rpcTunnel.addMethod("provider/contextUsage", async (params: any) => {
      const agentType = params?.agentType || "claude";
      const agent = getAgent(agentType);
      if (!agent?.getContextUsage)
        throw new Error(`Agent "${agentType}" does not support context usage`);
      return agent.getContextUsage({
        options: {
          cwd: params?.cwd ?? "",
          agentSessionId: params?.agentSessionId ?? "",
        },
      });
    });

    // --- provider/updateMode (runtime permission mode change) ---
    rpcTunnel.addMethod("provider/updateMode", (params: any) => {
      const agentType = params?.agentType || "claude";
      const agent = getAgent(agentType);
      if (agent?.updatePermissionMode) {
        void agent.updatePermissionMode(params?.sessionId, params?.permissionMode);
      }
    });

    // --- agent/list (introspection: list available agents) ---
    rpcTunnel.addMethod("agent/list", () => ({
      agents: this.getInitializedAgents(),
    }));
  }

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
      EventBroadcaster.detachTunnel(rpcTunnel);
    });
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Kills any remaining Claude child processes spawned by this agent-server.
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

    if (this.wss) {
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
   * 4. Print connection info to stdout (consumed by the Electron main process)
   */
  async start(): Promise<void> {
    await this.cleanup();

    // Register all agent handlers
    registerAgent(new ClaudeAgentHandler());
    registerAgent(new CodexAgentHandler());

    // Initialize all registered agents
    console.log("Initializing agent handlers...");
    this.initializedAgents.clear();
    const initResults = initializeAllAgents();
    for (const [agentType, result] of initResults) {
      if (!result.success) {
        console.error(`${agentType} initialization failed:`, result.error);
      } else {
        console.log(`${agentType} handler initialized successfully`);
        this.initializedAgents.add(agentType);
      }
    }

    // Mark agents as initialized for the /readyz endpoint only if at least one succeeded
    setAgentsInitialized(this.initializedAgents.size > 0);

    return this.listen();
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create an HTTP server for health endpoints + WS upgrade.
      // Binding to 127.0.0.1 — agent-server only accepts local connections.
      this.httpServer = createHttpServer((req, res) => {
        handleHttpRequest(req, res, this.wss);
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
        console.log(`Agent-server PID: ${process.pid}`);

        // Machine-readable output for the Electron main process / dev.sh
        originalLog(`LISTEN_URL=ws://127.0.0.1:${port}`);
        resolve();
      });

      this.httpServer.on("error", (error: Error) => {
        console.error("HTTP server error:", error);
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

const server = new AgentServer();
server.start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
