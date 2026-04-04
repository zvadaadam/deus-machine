import * as Sentry from "@sentry/node";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { initDatabase, closeDatabase, DB_PATH } from "./lib/database";
import { closeAll as closeAllWsConnections } from "./services/ws.service";
import { ensureRelayConnected, disconnectFromRelay } from "./services/relay.service";
import { getSetting } from "./services/settings.service";
import * as agentService from "./services/agent";
import { destroyAllPtySessions } from "./services/pty.service";
import { destroyAllWatchers } from "./services/fs-watcher.service";
import { setApp } from "./services/route-delegate";
import { invalidate } from "./services/query-engine";

// Initialize Sentry before anything else.
// DSN is a public, write-only ingest token — safe to hardcode.
Sentry.init({
  dsn: "https://7d01f9d51458e372a7e6f48649842653@o4510970844020736.ingest.us.sentry.io/4510971283898368",
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  sendDefaultPii: false,
  initialScope: { tags: { process: "backend" } },
});

/**
 * Deus Backend Server
 *
 * Handles workspace CRUD, sessions, repos, config, and stats.
 * Agent runtime (Claude SDK) is managed by the agent-server.
 */

// Initialize database
const db = initDatabase();

// Backfill git_origin_url for repos added before we tracked origin URLs.
// Runs once at startup (fire-and-forget) so WS subscribers get the data
// on their first snapshot instead of waiting for GET /repos.
async function backfillGitOriginUrls(): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const nullUrlRepos = db
      .prepare("SELECT id, root_path FROM repositories WHERE git_origin_url IS NULL")
      .all() as { id: string; root_path: string }[];
    if (nullUrlRepos.length === 0) return;

    let updated = 0;
    // Process in batches of 5 to cap concurrent git subprocesses
    const BATCH_SIZE = 5;
    for (let i = 0; i < nullUrlRepos.length; i += BATCH_SIZE) {
      const batch = nullUrlRepos.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (repo) => {
          const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
            cwd: repo.root_path,
            encoding: "utf-8",
            timeout: 2000,
          });
          const url = stdout.trim();
          if (url) {
            db.prepare("UPDATE repositories SET git_origin_url = ? WHERE id = ?").run(url, repo.id);
            return true;
          }
          return false;
        })
      );
      updated += results.filter((r) => r.status === "fulfilled" && r.value).length;
    }

    // Push fresh data to WS subscribers so sidebar shows GitHub icons immediately
    if (updated > 0) {
      invalidate(["workspaces"]);
    }
  } catch {
    // Backfill failed — not critical, icons will appear after next workspace creation
  }
}
void backfillGitOriginUrls();

// Create Hono app + WebSocket injector
const { app, injectWebSocket } = createApp();

// Register the Hono app for in-process route delegation (q:request/q:mutate → Hono routes)
setApp(app);

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

    console.log("\nDeus Backend Server");
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

// Connect to agent-server.
//
// Two bootstrap paths:
// 1. AGENT_SERVER_URL is set (dev.sh): agent-server already running, connect directly.
// 2. AGENT_SERVER_BUNDLE_PATH is set (Electron): spawn agent-server as child process,
//    parse LISTEN_URL from its stdout, then connect.
const agentServerUrl = process.env.AGENT_SERVER_URL;
const agentServerBundlePath = process.env.AGENT_SERVER_BUNDLE_PATH;

if (agentServerUrl) {
  // Path 1: Direct connection (dev.sh spawned the agent-server externally)
  agentService.init(agentServerUrl);
} else if (agentServerBundlePath) {
  // Path 2: Spawn agent-server and connect (Electron desktop mode)
  void spawnAgentServerAndConnect(agentServerBundlePath);
}

// Track agent-server child process for cleanup on shutdown
let agentServerChild: import("child_process").ChildProcess | null = null;

function killAgentServer(): void {
  if (agentServerChild && !agentServerChild.killed) {
    agentServerChild.kill("SIGTERM");
    agentServerChild = null;
  }
}

/** Spawn the agent-server bundle as a child process and connect to its WebSocket. */
async function spawnAgentServerAndConnect(bundlePath: string): Promise<void> {
  const { spawn } = await import("child_process");
  const fs = await import("fs");

  if (!fs.existsSync(bundlePath)) {
    console.error(`[server] Agent-server bundle not found: ${bundlePath}`);
    return;
  }

  agentServerChild = spawn(process.execPath, [bundlePath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Forward database path so agent-server can pass it to agents
      DATABASE_PATH: process.env.DATABASE_PATH,
    },
  });

  const agentServer = agentServerChild!;
  let stdoutBuffer = "";

  agentServer.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log("[agent-server]", trimmed);

      // Capture the LISTEN_URL and connect
      if (trimmed.startsWith("LISTEN_URL=")) {
        const url = trimmed.slice("LISTEN_URL=".length);
        console.log(`[server] Agent-server spawned and listening at ${url}`);
        agentService.init(url);
      }
    }
  });

  agentServer.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error("[agent-server:stderr]", line.trim());
    }
  });

  agentServer.on("exit", (code, signal) => {
    console.log(`[agent-server] Exited with code=${code} signal=${signal}`);
    agentServerChild = null;
  });
}

// Global error handlers
process.on("uncaughtException", (error, origin) => {
  console.error("[FATAL] Uncaught Exception:", origin, error);
  Sentry.captureException(error);
  Sentry.close(2000).finally(() => {
    destroyAllPtySessions();
    destroyAllWatchers();
    killAgentServer();
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
  destroyAllPtySessions();
  destroyAllWatchers();
  killAgentServer();
  disconnectFromRelay();
  closeAllWsConnections();
  closeDatabase();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
