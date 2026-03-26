/**
 * Backend Process Manager
 *
 * Spawns the Node.js backend as a child process using Electron's built-in
 * Node runtime (ELECTRON_RUN_AS_NODE=1) in both dev and production.
 * This ensures native modules (better-sqlite3, node-pty) compiled by
 * electron-builder always match the runtime ABI — no system Node required.
 *
 * Parses the dynamic port from stdout, generates an auth token, and handles
 * exit/restart with exponential backoff.
 */

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { writeFileSync } from "fs";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";

let backendProcess: ChildProcess | null = null;
let isQuitting = false;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTART_ATTEMPTS = 5;
const STARTUP_TIMEOUT_MS = 30_000;

export async function spawnBackend(): Promise<{ port: number; authToken: string }> {
  const authToken = crypto.randomBytes(24).toString("hex");
  const projectRoot = join(__dirname, "../..");
  // Always use Electron's Node binary for the backend process.
  // electron-builder install-app-deps compiles native modules (better-sqlite3, node-pty)
  // against Electron's Node ABI. Using system node would cause MODULE_VERSION mismatch.
  const backendRuntime = process.execPath;

  // Resolve backend entry point
  // Production: bundled CJS file (no tsx dependency needed)
  // Development: server.cjs bootstraps tsx for live TypeScript
  const backendEntry = app.isPackaged
    ? join(process.resourcesPath, "backend", "server.bundled.cjs")
    : join(projectRoot, "apps/backend/server.cjs");

  // Database lives in Electron's userData dir (~/Library/Application Support/Deus/).
  const dbPath = join(app.getPath("userData"), "deus.db");

  // Agent-server bundle path
  const agentServerPath = app.isPackaged
    ? join(process.resourcesPath, "bin", "index.bundled.cjs")
    : join(projectRoot, "apps/agent-server/dist/index.bundled.cjs");

  // Notebook server bundle path
  const notebookPath = app.isPackaged
    ? join(process.resourcesPath, "bin", "notebook-server.bundled.cjs")
    : join(projectRoot, "packages/mcp-notebook/dist/notebook-server.bundled.cjs");

  return new Promise((resolve, reject) => {
    backendProcess = spawn(backendRuntime, [backendEntry], {
      cwd: app.isPackaged ? process.resourcesPath : join(projectRoot, "apps/backend"),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DATABASE_PATH: dbPath,
        AGENT_SERVER_BUNDLE_PATH: agentServerPath,
        NOTEBOOK_SERVER_BUNDLE_PATH: notebookPath,
        AUTH_TOKEN: authToken,
        PORT: "0", // Dynamic port allocation
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    let stdoutBuffer = "";

    // Parse port from stdout
    backendProcess.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? ""; // Keep incomplete last line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Log backend stdout in dev mode
        if (!app.isPackaged) {
          console.log("[backend]", trimmed);
        }

        const portMatch = trimmed.match(/^\[BACKEND_PORT\](\d+)$/);
        if (portMatch && !resolved) {
          resolved = true;
          restartAttempt = 0;
          const port = parseInt(portMatch[1], 10);

          // Write port to temp file so Chrome tabs (without electronAPI) can discover it.
          // The Vite dev server serves this via middleware in electron.vite.config.ts.
          if (!app.isPackaged) {
            try {
              const portFile = join(app.getPath("temp"), "deus-backend-port");
              writeFileSync(portFile, String(port));
            } catch {
              // Non-critical — only used for Chrome tab port discovery
            }
          }

          resolve({ port, authToken });
        }

        // Relay workspace init progress events to the renderer.
        // Backend emits: DEUS_WORKSPACE_PROGRESS:{"workspaceId":"...","step":"...","label":"..."}
        // We parse the JSON and forward it as an IPC event to the renderer.
        // SYNC: Event name must match shared/events.ts (AppEventMap["workspace:progress"])
        if (trimmed.startsWith("DEUS_WORKSPACE_PROGRESS:")) {
          const jsonStr = trimmed.slice("DEUS_WORKSPACE_PROGRESS:".length);
          try {
            const payload = JSON.parse(jsonStr);
            const win = BrowserWindow.getAllWindows()[0];
            if (win) {
              win.webContents.send("workspace:progress", payload);
            }
          } catch {
            // Ignore malformed progress lines
          }
        }
      }
    });

    backendProcess.stderr?.on("data", (data: Buffer) => {
      console.error("[backend:stderr]", data.toString().trim());
    });

    backendProcess.on("exit", (code, signal) => {
      console.log(`[backend] Exited with code=${code} signal=${signal}`);
      backendProcess = null;

      if (!resolved) {
        reject(new Error(`Backend exited before starting (code=${code})`));
        return;
      }

      // Restart with exponential backoff (unless app is quitting)
      if (!isQuitting && restartAttempt < MAX_RESTART_ATTEMPTS) {
        restartAttempt++;
        const delay = Math.min(1000 * Math.pow(2, restartAttempt - 1), 30_000);
        console.log(`[backend] Restart attempt ${restartAttempt} in ${delay}ms`);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          spawnBackend()
            .then(({ port, authToken: newAuthToken }) => {
              // Update env vars so IPC handlers (native:getBackendPort) return the new port
              process.env.DEUS_BACKEND_PORT = String(port);
              process.env.DEUS_AUTH_TOKEN = newAuthToken;

              // Notify all renderer windows so they can invalidate their cached port
              // and reconnect WebSocket to the new address.
              for (const win of BrowserWindow.getAllWindows()) {
                win.webContents.send("backend:port-changed", { port });
              }
              console.log(`[backend] Restarted on port ${port}, notified renderer`);
            })
            .catch((err) => {
              console.error("[backend] Restart failed:", err);
            });
        }, delay);
      }
    });

    backendProcess.on("error", (err) => {
      console.error("[backend] Spawn error:", err);
      if (!resolved) {
        reject(err);
      }
    });

    // Timeout if backend doesn't start
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        backendProcess?.kill("SIGTERM");
        reject(new Error(`Backend startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
      }
    }, STARTUP_TIMEOUT_MS);
  });
}

export function stopBackend(): void {
  isQuitting = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (backendProcess) {
    backendProcess.kill("SIGTERM");
    // Force kill after 5s if graceful shutdown fails
    const forceTimer = setTimeout(() => {
      if (backendProcess) {
        backendProcess.kill("SIGKILL");
        backendProcess = null;
      }
    }, 5_000);
    backendProcess.on("exit", () => {
      clearTimeout(forceTimer);
      backendProcess = null;
    });
  }
}
