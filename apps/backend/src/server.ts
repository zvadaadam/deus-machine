import * as Sentry from "@sentry/node";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { initDatabase, closeDatabase, DB_PATH } from "./lib/database";
import { closeAll as closeAllWsConnections } from "./services/ws.service";
import { ensureRelayConnected, disconnectFromRelay } from "./services/relay.service";
import { getSetting } from "./services/settings.service";
import * as agentService from "./services/agent";
import { stopBrowserServer } from "./services/browser-server.service";
import { destroyAllPtySessions } from "./services/pty.service";
import { destroyAllWatchers } from "./services/fs-watcher.service";

// Initialize Sentry before anything else.
// DSN passed as env var from Electron main process (not hardcoded — open source repo).
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    sendDefaultPii: false,
    initialScope: { tags: { process: "backend" } },
  });
}

/**
 * OpenDevs Backend Server
 *
 * Handles workspace CRUD, sessions, repos, config, and stats.
 * Agent runtime (Claude SDK) is managed by the agent-server (sidecar).
 */

// Initialize database
const db = initDatabase();

// Create Hono app + WebSocket injector
const { app, injectWebSocket } = createApp();

// Global variable to store actual port (used by health endpoint)
let actualServerPort: number | null = null;

export function getServerPort() {
  return actualServerPort;
}

// Start server with dynamic port allocation
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;

// Bind 0.0.0.0 to accept connections from all interfaces.
// Remote access is gated by remoteGateMiddleware (rejects non-localhost when disabled).
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: "0.0.0.0",
  },
  (info) => {
    actualServerPort = info.port;

    // CRITICAL: Machine-readable port output for Electron main process and dev.sh
    console.log(`[BACKEND_PORT]${info.port}`);

    console.log("\nOpenDevs Backend Server");
    console.log(`API Server: http://0.0.0.0:${info.port}`);
    console.log(`Database: ${DB_PATH}`);
    console.log("Server ready!\n");
  }
);

// Inject WebSocket support into the HTTP server
injectWebSocket(server);

const remoteEnabled = getSetting("remote_access_enabled");
if (remoteEnabled === true) {
  ensureRelayConnected();
}

// Connect to agent-server (sidecar).
//
// Two bootstrap paths:
// 1. AGENT_SERVER_URL is set (dev.sh): sidecar already running, connect directly.
// 2. SIDECAR_BUNDLE_PATH is set (Electron): spawn sidecar as child process,
//    parse LISTEN_URL from its stdout, then connect.
const agentServerUrl = process.env.AGENT_SERVER_URL;
const sidecarBundlePath = process.env.SIDECAR_BUNDLE_PATH;

if (agentServerUrl) {
  // Path 1: Direct connection (dev.sh spawned the sidecar externally)
  agentService.init(agentServerUrl);
} else if (sidecarBundlePath) {
  // Path 2: Spawn sidecar and connect (Electron desktop mode)
  void spawnSidecarAndConnect(sidecarBundlePath);
}

// Track sidecar child process for cleanup on shutdown
let sidecarChild: import("child_process").ChildProcess | null = null;

function killSidecar(): void {
  if (sidecarChild && !sidecarChild.killed) {
    sidecarChild.kill("SIGTERM");
    sidecarChild = null;
  }
}

/** Spawn the sidecar bundle as a child process and connect to its WebSocket. */
async function spawnSidecarAndConnect(bundlePath: string): Promise<void> {
  const { spawn } = await import("child_process");
  const fs = await import("fs");

  if (!fs.existsSync(bundlePath)) {
    console.error(`[server] Sidecar bundle not found: ${bundlePath}`);
    return;
  }

  sidecarChild = spawn(process.execPath, [bundlePath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Forward database path so sidecar can pass it to agents
      DATABASE_PATH: process.env.DATABASE_PATH,
      // Forward notebook server path
      NOTEBOOK_SERVER_BUNDLE_PATH: process.env.NOTEBOOK_SERVER_BUNDLE_PATH,
    },
  });

  const sidecar = sidecarChild!;
  let stdoutBuffer = "";

  sidecar.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log("[sidecar]", trimmed);

      // Capture the LISTEN_URL and connect
      if (trimmed.startsWith("LISTEN_URL=")) {
        const url = trimmed.slice("LISTEN_URL=".length);
        console.log(`[server] Sidecar spawned and listening at ${url}`);
        agentService.init(url);
      }
    }
  });

  sidecar.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error("[sidecar:stderr]", line.trim());
    }
  });

  sidecar.on("exit", (code, signal) => {
    console.log(`[sidecar] Exited with code=${code} signal=${signal}`);
    sidecarChild = null;
  });
}

// Global error handlers
process.on("uncaughtException", (error, origin) => {
  console.error("[FATAL] Uncaught Exception:", origin, error);
  Sentry.captureException(error);
  Sentry.close(2000).finally(() => {
    stopBrowserServer();
    destroyAllPtySessions();
    destroyAllWatchers();
    killSidecar();
    try {
      closeDatabase();
    } catch {}
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason) => {
  // Sentry's built-in onUnhandledRejectionIntegration captures and normalizes
  // rejection reasons automatically. We only log here for local visibility.
  console.error("[FATAL] Unhandled Promise Rejection:", reason);
});

// Graceful shutdown
function shutdown() {
  console.log("\nShutting down...");
  agentService.shutdown();
  stopBrowserServer();
  destroyAllPtySessions();
  destroyAllWatchers();
  killSidecar();
  disconnectFromRelay();
  closeAllWsConnections();
  closeDatabase();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
