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
import {
  reconcile as reconcileSimulators,
  destroyAll as destroyAllSimulators,
} from "./services/simulator-context";
import { prefetchInstalledAppAssets, stopAllApps, sweepOrphanApps } from "./services/aap";
import { setApp } from "./services/route-delegate";
import { invalidate } from "./services/query-engine";
import {
  setRefreshListener as setLocalServerRefreshListener,
  startBackgroundRefresh as startLocalServerDiscovery,
  stopBackgroundRefresh as stopLocalServerDiscovery,
} from "./services/local-servers.service";
import { startManagedAgentServer, stopManagedAgentServer } from "./runtime/agent-process";

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

// AAP orphan sweep: on restart after an ungraceful shutdown (SIGKILL, OOM,
// crash), child app processes can outlive the backend. The PID journal
// remembers their pids across restarts; we kill any still alive before
// accepting new commands so a re-launch allocates a fresh instance cleanly.
sweepOrphanApps();
prefetchInstalledAppAssets();

// Backfill git_origin_url for repos added before we tracked origin URLs.
// Runs once at startup (fire-and-forget) so WS subscribers get the data
// on their first snapshot instead of waiting for GET /repos.
async function backfillGitOriginUrls(): Promise<void> {
  const { getGitRemoteUrl } = await import("./lib/git-remotes");

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
          const url = await getGitRemoteUrl(repo.root_path);
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
const allowAgentless =
  process.env.AGENT_ALLOW_AGENTLESS === "1" || process.env.AGENT_ALLOW_AGENTLESS === "true";

async function resolveAgentServerUrl(): Promise<string | null> {
  if (process.env.AGENT_SERVER_URL) return process.env.AGENT_SERVER_URL;
  if (allowAgentless) return null;
  return startManagedAgentServer();
}

async function onListening(port: number): Promise<void> {
  actualServerPort = port;

  const agentServerUrl = await resolveAgentServerUrl();
  if (agentServerUrl) {
    agentService.init(agentServerUrl);
  } else {
    console.warn("[server] Starting in explicit agentless mode (AGENT_ALLOW_AGENTLESS=true)");
  }

  // CRITICAL: Machine-readable port output for Electron main process and dev.
  // Emitted after agent-server startup so launchers see a fully wired runtime.
  console.log(`[BACKEND_PORT]${port}`);

  console.log("\nDeus Backend Server");
  console.log(`API Server: http://0.0.0.0:${port}`);
  console.log(`Database: ${DB_PATH}`);
  console.log("Server ready!\n");

  const remoteEnabled = getSetting("remote_access_enabled");
  if (remoteEnabled === true) {
    ensureRelayConnected();
  }

  // Discover booted simulators on startup (fire-and-forget).
  // Restores awareness of running simulators after a backend restart.
  void reconcileSimulators();

  // Periodic localhost dev-server discovery. Probes a curated port list
  // every 60s; the refresh listener pushes a fresh snapshot to all
  // `local_servers` WS subscribers each time a sweep completes.
  setLocalServerRefreshListener(() => invalidate(["local_servers"]));
  startLocalServerDiscovery();
}

// Bind 0.0.0.0 to accept connections from all interfaces.
// Remote access is gated by remoteGateMiddleware (rejects non-localhost when disabled).
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: "0.0.0.0",
  },
  (info) => {
    void onListening(info.port).catch((error) => {
      console.error("[server] Startup failed:", error);
      process.exit(1);
    });
  }
);

// Inject WebSocket support into the HTTP server
injectWebSocket(server);

// Global error handlers
process.on("uncaughtException", (error, origin) => {
  console.error("[FATAL] Uncaught Exception:", origin, error);
  Sentry.captureException(error);
  Sentry.close(2000).finally(() => {
    stopAllApps();
    destroyAllSimulators();
    destroyAllPtySessions();
    destroyAllWatchers();
    void stopManagedAgentServer();
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
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down...");
  agentService.shutdown();
  void stopManagedAgentServer().finally(() => {
    stopAllApps();
    destroyAllSimulators();
    destroyAllPtySessions();
    destroyAllWatchers();
    stopLocalServerDiscovery();
    disconnectFromRelay();
    closeAllWsConnections();
    closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
