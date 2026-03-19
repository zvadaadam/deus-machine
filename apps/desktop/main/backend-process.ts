/**
 * Backend Process Manager
 *
 * Spawns the Node.js backend as a child process using ELECTRON_RUN_AS_NODE=1.
 * Parses the dynamic port from stdout, generates an auth token, and handles
 * exit/restart with exponential backoff.
 *
 * Uses child_process directly since we're already in Node.js.
 */

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";

let backendProcess: ChildProcess | null = null;
let isQuitting = false;
let restartAttempt = 0;
const MAX_RESTART_ATTEMPTS = 5;
const STARTUP_TIMEOUT_MS = 30_000;

export async function spawnBackend(): Promise<{ port: number; authToken: string }> {
  const authToken = crypto.randomBytes(24).toString("hex");

  // Resolve backend entry point
  const backendEntry = app.isPackaged
    ? join(process.resourcesPath, "backend", "server.cjs")
    : join(__dirname, "../../backend/server.cjs");

  // Database path — prefer legacy Tauri location (com.opendevs.ide) if it exists,
  // otherwise use Electron's userData dir (~/Library/Application Support/opendevs/).
  const legacyTauriPath = join(app.getPath("appData"), "com.opendevs.ide", "opendevs.db");
  const electronDbPath = join(app.getPath("userData"), "opendevs.db");
  const dbPath = existsSync(legacyTauriPath) ? legacyTauriPath : electronDbPath;

  // Sidecar bundle path
  const sidecarPath = app.isPackaged
    ? join(process.resourcesPath, "bin", "index.bundled.cjs")
    : join(__dirname, "../../sidecar/dist/index.bundled.cjs");

  // Notebook server bundle path
  const notebookPath = app.isPackaged
    ? join(process.resourcesPath, "bin", "notebook-server.bundled.cjs")
    : join(__dirname, "../../packages/mcp-notebook/dist/notebook-server.bundled.cjs");

  return new Promise((resolve, reject) => {
    backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: app.isPackaged ? process.resourcesPath : join(__dirname, "../../backend"),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        DATABASE_PATH: dbPath,
        SIDECAR_BUNDLE_PATH: sidecarPath,
        NOTEBOOK_SERVER_BUNDLE_PATH: notebookPath,
        AUTH_TOKEN: authToken,
        PORT: "0", // Dynamic port allocation
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;

    // Parse port from stdout (same pattern as current Rust BackendManager)
    backendProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Log backend stdout in dev mode
        if (!app.isPackaged) {
          console.log("[backend]", trimmed);
        }

        // Match both formats: "[BACKEND_PORT]12345" (primary) and
        // "Backend server started on port 12345" (legacy fallback).
        // The Rust BackendManager uses [BACKEND_PORT] — match that first.
        const portMatch =
          trimmed.match(/^\[BACKEND_PORT\](\d+)$/) ||
          trimmed.match(/Backend server started on port (\d+)/);
        if (portMatch && !resolved) {
          resolved = true;
          restartAttempt = 0;
          resolve({ port: parseInt(portMatch[1], 10), authToken });
        }

        // Relay workspace init progress events to the renderer.
        // Backend emits: OPENDEVS_WORKSPACE_PROGRESS:{"workspaceId":"...","step":"...","label":"..."}
        // We parse the JSON and forward it as an IPC event (same as Rust BackendManager).
        // SYNC: Event name must match shared/events.ts (AppEventMap["workspace:progress"])
        if (trimmed.startsWith("OPENDEVS_WORKSPACE_PROGRESS:")) {
          const jsonStr = trimmed.slice("OPENDEVS_WORKSPACE_PROGRESS:".length);
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
        setTimeout(() => {
          spawnBackend()
            .then(({ port, authToken: newAuthToken }) => {
              // Update env vars so IPC handlers (native:getBackendPort) return the new port
              process.env.OPENDEVS_BACKEND_PORT = String(port);
              process.env.OPENDEVS_AUTH_TOKEN = newAuthToken;

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
