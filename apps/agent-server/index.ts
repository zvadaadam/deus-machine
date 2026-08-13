// agent-server/index.ts
// Entry point for the Deus agent-server process.
//
// The process serves the standard @zvada/agent-server wire (JSON-RPC 2.0,
// per-session seq, bounded replay) over a WebSocket on 127.0.0.1 (dynamic
// port), with deus/* side-channel frames multiplexed on the same pipe (see
// shared/agent-side-channel.ts). The engine runs in-process with the deus
// embed-tier seams: in-process MCP tool suite, tool policy, checkpoint hooks.

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
import { WebSocketServer } from "ws";
import { AgentServer as WireServer } from "./upstream-server";

import { adoptBundledClis } from "./agents/core/bundled-clis";
import { applyShellEnvironment } from "./agents/environment";
import { getRuntime } from "./agents/core/engine";
import { installFileLogger } from "./logging";
import { killChildProcesses } from "./process-cleanup";
import { bridgeWsConnection, createEventObserverTransport } from "./wire";

const logger = installFileLogger();
export const logFilePath = logger.logFilePath;

async function start(): Promise<void> {
  console.log("AgentServer: Initializing...");

  // Packaged/staged runtimes: adopt bundled CLIs before the engine registry
  // exists (its provisioner honors the CLI-path env overrides).
  adoptBundledClis();

  // Dev/source only: fold the login shell's environment into process.env once
  // at startup. The engine spreads process.env under every harness subprocess,
  // so this replaces the legacy per-turn env layering (process.env wins).
  applyShellEnvironment();

  const runtime = getRuntime();
  const wireServer = new WireServer(runtime, { info: { name: "deus-agent-server" } });
  wireServer.attach(createEventObserverTransport());

  // Binding to 127.0.0.1 — agent-server only accepts local connections.
  const httpServer = createHttpServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => bridgeWsConnection(ws, wireServer));
  wss.on("error", (error: Error) => console.error("WebSocketServer error:", error));

  const SHUTDOWN_TIMEOUT_MS = 15_000;
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SIGNAL] Received ${signal}, shutting down...`);
    httpServer.close();
    // A wedged harness subprocess must not make the process unkillable-by-
    // SIGTERM (the spawner escalates to SIGKILL, but quit should not hang).
    const forceExit = setTimeout(() => {
      console.error("[SIGNAL] Cleanup timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    try {
      // Cancels in-flight turns (their turn.ended still broadcasts), releases
      // harness subprocesses, closes every attached transport.
      await wireServer.shutdown();
      await killChildProcesses();
      for (const client of wss.clients) client.close(1001, "Server shutting down");
      wss.close();
      console.log("[SIGNAL] Cleanup complete, exiting process");
    } catch (error) {
      console.error("[SIGNAL] Cleanup failed:", error);
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  await new Promise<void>((resolve, reject) => {
    // Port 0 = OS-assigned dynamic port
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      console.log(`Agent-server listening on ws://127.0.0.1:${port}`);
      console.log(`Agent-server PID: ${process.pid}`);

      // Machine-readable output for the backend spawner / dev.sh
      logger.writeStdout(`LISTEN_URL=ws://127.0.0.1:${port}`);
      resolve();
    });
    httpServer.on("error", (error: Error) => {
      console.error("HTTP server error:", error);
      reject(error);
    });
  });
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

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
