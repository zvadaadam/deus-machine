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

import { createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

import { RpcConnection, wsTransport } from "./rpc-connection";
import { EventBroadcaster } from "./event-broadcaster";
import {
  registerAgent,
  getAgent,
  initializeAllAgents,
  getRegisteredAgentHarnesses,
} from "./agents/registry";
import { ClaudeAgentHandler } from "./agents/claude/claude-handler";
import { CodexAgentHandler } from "./agents/codex/codex-handler";
import { CodexServerAgentHandler } from "./agents/codex-server/codex-server-handler";
import { installFileLogger } from "./logging";
import { killChildProcesses } from "./process-cleanup";
import { registerRpcMethods } from "./rpc-methods";
import {
  handleHttpRequest,
  setShuttingDown,
  setAgentsInitialized,
  waitForDrain,
  cancelRemainingSessions,
} from "./health";

const logger = installFileLogger();
export const logFilePath = logger.logFilePath;

class AgentServer {
  private initializedAgents = new Set<string>();
  private httpServer: ReturnType<typeof createHttpServer> | null = null;
  private wss: WebSocketServer | null = null;

  constructor() {
    console.log("AgentServer: Initializing...");

    const gracefulShutdown = async (signal: string) => {
      console.log(`\n[SIGNAL] Received ${signal}, shutting down gracefully...`);

      setShuttingDown(true);

      if (this.httpServer) {
        this.httpServer.close();
        console.log("[SHUTDOWN] HTTP server closed to new connections");
      }

      console.log("[SHUTDOWN] Waiting for in-flight turns to drain...");
      const drained = await waitForDrain();
      if (drained) {
        console.log("[SHUTDOWN] All turns drained successfully");
      } else {
        console.log("[SHUTDOWN] Drain timeout reached, cancelling remaining sessions");
        await cancelRemainingSessions();
      }

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
    for (const agentHarness of getRegisteredAgentHarnesses()) {
      const handler = getAgent(agentHarness);
      if (handler && this.initializedAgents.has(agentHarness)) {
        agents.push({ type: agentHarness, capabilities: handler.capabilities, initialized: true });
      }
    }
    return agents;
  }

  /**
   * Wires up all JSON-RPC methods and notifications on a new connection.
   */
  private setupJsonRpc(rpcTunnel: RpcConnection): void {
    registerRpcMethods(rpcTunnel, {
      getInitializedAgents: () => this.getInitializedAgents(),
    });
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

  private async cleanup(): Promise<void> {
    await killChildProcesses();

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

  async start(): Promise<void> {
    await this.cleanup();

    registerAgent(new ClaudeAgentHandler());
    registerAgent(new CodexAgentHandler());
    registerAgent(new CodexServerAgentHandler());

    console.log("Initializing agent handlers...");
    this.initializedAgents.clear();
    const initResults = initializeAllAgents();
    for (const [agentHarness, result] of initResults) {
      if (!result.success) {
        console.error(`${agentHarness} initialization failed:`, result.error);
      } else {
        console.log(`${agentHarness} handler initialized successfully`);
        this.initializedAgents.add(agentHarness);
      }
    }

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
        logger.writeStdout(`LISTEN_URL=ws://127.0.0.1:${port}`);
        resolve();
      });

      this.httpServer.on("error", (error: Error) => {
        console.error("HTTP server error:", error);
        reject(error);
      });
    });
  }
}

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

const server = new AgentServer();
server.start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
