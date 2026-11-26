import * as Sentry from "@sentry/node";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { initDatabase, closeDatabase, DB_PATH } from "./lib/database";
import { stopProcessGroups } from "@shared/lib/process-groups";
import { beforeBreadcrumb } from "@shared/lib/sentry-breadcrumb";
import {
  closeAll as closeAllWsConnections,
  onDeviceConnectionsChange,
} from "./services/ws.service";
import { syncKeepAwake } from "./services/keep-awake.service";
import { notifyDevicesChanged } from "./services/remote-auth.service";
import { reconcileRelay, disconnectFromRelay } from "./services/relay.service";
import * as agentService from "./services/agent";
import { destroyAllPtySessions } from "./services/pty.service";
import { deviceHub } from "./services/device-hub";
import { destroyAllWatchers } from "./services/fs-watcher.service";
import { invalidate } from "./services/query-engine";
import {
  setRefreshListener as setLocalServerRefreshListener,
  startBackgroundRefresh as startLocalServerDiscovery,
  stopBackgroundRefresh as stopLocalServerDiscovery,
} from "./services/local-servers.service";
import { initAutomations } from "./services/automations";
import { refreshCloudOrganizations } from "./services/cloud-settings.service";
import { forgetUnusedAssistants } from "./services/assistants";
import { startIntegrations } from "./services/integrations";
import { failInterruptedWorkspaces } from "./services/workspace-init.service";
import { deleteEmptyUnnamedProjects } from "./services/workspace-lifecycle";
import { stopWhenStdinEnds } from "./lib/parent-stdin";

// Initialize Sentry before anything else.
// DSN is a public, write-only ingest token — safe to hardcode.
Sentry.init({
  dsn: "https://7d01f9d51458e372a7e6f48649842653@o4510970844020736.ingest.us.sentry.io/4510971283898368",
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  sendDefaultPii: false,
  beforeBreadcrumb,
  initialScope: { tags: { process: "backend" } },
});

/**
 * Deus Backend Server
 *
 * Handles workspace CRUD, sessions, repos and config.
 * Runs the agent engine (@zvada/agent-server) in this process.
 */

// Initialize database
const db = initDatabase();
// Assistants unused for a month are forgotten (also whenever the list is read).
forgetUnusedAssistants();
deleteEmptyUnnamedProjects();

// Workspaces the previous process was still starting when it stopped.
void failInterruptedWorkspaces()
  .then((count) => {
    if (count) console.log(`[server] ${count} interrupted workspace start(s) failed`);
  })
  .catch((err) => console.warn("[server] Workspace recovery failed:", err));

// Backfill git_origin_url for repos added before we tracked origin URLs.
// Runs in the background at startup and publishes any origins it finds.
async function backfillGitOriginUrls(): Promise<void> {
  const { getGitRemoteUrl } = await import("./lib/git-remotes");

  try {
    const nullUrlRepos = db
      // A project with no folder here has nothing for git to read.
      .prepare(
        "SELECT id, root_path FROM repositories WHERE git_origin_url IS NULL AND root_path IS NOT NULL"
      )
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
      invalidate(["workspaces", "repos"]);
    }
  } catch {
    // Backfill failed — not critical, icons will appear after next workspace creation
  }
}
void backfillGitOriginUrls();

// Create Hono app + WebSocket injector
const { app, injectWebSocket } = createApp();

// Global variable to store actual port (used by health endpoint)
let actualServerPort: number | null = null;

export function getServerPort() {
  return actualServerPort;
}

// Start server with dynamic port allocation
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;
const allowAgentless =
  process.env.AGENT_ALLOW_AGENTLESS === "1" || process.env.AGENT_ALLOW_AGENTLESS === "true";

async function onListening(port: number): Promise<void> {
  actualServerPort = port;
  // Customize: app sign-ins return here, and agents reach apps through its gateway.
  void startIntegrations(port);

  if (!allowAgentless) {
    await agentService.init();
  } else {
    console.warn("[server] Starting in explicit agentless mode (AGENT_ALLOW_AGENTLESS=true)");
  }

  // CRITICAL: Machine-readable port output for Electron main process and dev.
  // Emitted after the engine starts so launchers see a fully wired runtime.
  console.log(`[BACKEND_PORT]${port}`);

  console.log("\nDeus Backend Server");
  console.log(`API Server: http://0.0.0.0:${port}`);
  console.log(`Database: ${DB_PATH}`);
  console.log("Server ready!\n");

  // Waits for the desktop's account session when it is not handed over yet.
  reconcileRelay();
  // A connected device can keep the Mac awake (the desktop holds the blocker).
  onDeviceConnectionsChange(() => {
    syncKeepAwake();
    notifyDevicesChanged();
  });

  // Periodic localhost dev-server discovery. Probes a curated port list
  // every 60s; the refresh listener pushes a fresh snapshot to all
  // `localServers` WS subscribers each time a sweep completes.
  setLocalServerRefreshListener(() => invalidate(["localServers"]));
  startLocalServerDiscovery();

  // Automations are cloud-only (agnt schedules + executes) — just mirror the
  // platform into the local cache when credentials are already present.
  initAutomations();
  // This backend's cloud, read from the platform when an account is already here.
  refreshCloudOrganizations();
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
  stopProcessGroups();
  Promise.allSettled([Sentry.close(2000), deviceHub.shutdown()]).finally(() => {
    destroyAllPtySessions();
    destroyAllWatchers();
    void agentService.shutdown();
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
  // First, so a checkout or a setup script stops while the rest shuts down.
  stopProcessGroups();
  void Promise.allSettled([agentService.shutdown(), deviceHub.shutdown()]).finally(() => {
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
// Started by the desktop: stop when it does, even if it crashed or was killed.
if (stopWhenStdinEnds(shutdown)) console.log("[server] Stopping when the desktop does");
