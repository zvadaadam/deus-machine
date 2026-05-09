/**
 * Electron runtime wrapper.
 *
 * Generic process orchestration lives in apps/runtime/supervisor.ts. This file
 * only supplies Electron paths, desktop-specific env, restart policy, and UI
 * event relay.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";
import { DEUS_DB_FILENAME } from "../../../shared/runtime";
import { extendCliPath } from "../../../shared/lib/cli-path";
import {
  RuntimeSupervisor,
  type RuntimeEntries,
  type RuntimeProcessHooks,
} from "../../runtime/supervisor";

export const CDP_PORT = "19222";

let supervisor: RuntimeSupervisor | null = null;
let isQuitting = false;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTART_ATTEMPTS = 5;

export type BackendSpawnHooks = RuntimeProcessHooks;

interface ElectronRuntimeEntries extends RuntimeEntries {
  backendEntry: string;
  agentServerEntry: string;
  backendCwd: string;
  agentServerCwd: string;
  resourcesPath?: string;
  nodePath?: string;
  bundledBinDir?: string;
}

function resolveRuntimeEntries(): ElectronRuntimeEntries {
  const projectRoot = join(__dirname, "../..");

  if (app.isPackaged) {
    return {
      backendEntry: join(process.resourcesPath, "backend", "server.bundled.cjs"),
      agentServerEntry: join(process.resourcesPath, "bin", "index.bundled.cjs"),
      backendCwd: app.getPath("userData"),
      agentServerCwd: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
      nodePath: join(process.resourcesPath, "app.asar", "node_modules"),
      bundledBinDir: join(process.resourcesPath, "bin"),
    };
  }

  return {
    backendEntry: join(projectRoot, "apps/backend/server.cjs"),
    agentServerEntry: join(projectRoot, "apps/agent-server/dist/index.bundled.cjs"),
    backendCwd: join(projectRoot, "apps/backend"),
    agentServerCwd: join(projectRoot, "apps/agent-server"),
  };
}

function relayWorkspaceProgress(line: string): void {
  if (!line.startsWith("DEUS_WORKSPACE_PROGRESS:")) return;

  const jsonStr = line.slice("DEUS_WORKSPACE_PROGRESS:".length);
  try {
    const payload = JSON.parse(jsonStr);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("workspace:progress", payload);
      }
    }
  } catch {
    // Ignore malformed progress lines
  }
}

function writeBackendPortFile(port: number): void {
  if (app.isPackaged) return;

  try {
    const portFile = join(app.getPath("temp"), "deus-backend-port");
    writeFileSync(portFile, String(port));
  } catch {
    // Non-critical — only used for Chrome tab port discovery
  }
}

function scheduleRestart(
  hooks: BackendSpawnHooks,
  createSupervisor: () => RuntimeSupervisor
): void {
  if (isQuitting || restartTimer || restartAttempt >= MAX_RESTART_ATTEMPTS) {
    return;
  }

  restartAttempt++;
  const delay = Math.min(1000 * Math.pow(2, restartAttempt - 1), 30_000);
  console.log(`[runtime] Restart attempt ${restartAttempt} in ${delay}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    void (async () => {
      try {
        supervisor = createSupervisor();
        const { backendPort: port } = await supervisor.start();
        process.env.DEUS_BACKEND_PORT = String(port);
        writeBackendPortFile(port);

        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("backend:port-changed", { port });
        }
        console.log(`[runtime] Restarted on port ${port}, notified renderer`);
      } catch (err) {
        console.error("[runtime] Restart failed:", err);
        scheduleRestart(hooks, createSupervisor);
      }
    })();
  }, delay);
}

export async function spawnBackend(
  hooks: BackendSpawnHooks = {}
): Promise<{ port: number; authToken: string }> {
  const authToken = crypto.randomBytes(24).toString("hex");
  const runtime = resolveRuntimeEntries();
  const dbPath = join(app.getPath("userData"), DEUS_DB_FILENAME);

  const sharedEnv = {
    DATABASE_PATH: dbPath,
    PATH: extendCliPath(process.env.PATH),
    ...(runtime.resourcesPath
      ? { DEUS_PACKAGED: "1", DEUS_RESOURCES_PATH: runtime.resourcesPath }
      : {}),
    ...(runtime.nodePath ? { NODE_PATH: runtime.nodePath } : {}),
    ...(runtime.bundledBinDir ? { DEUS_BUNDLED_BIN_DIR: runtime.bundledBinDir } : {}),
  };

  const createSupervisor = () =>
    new RuntimeSupervisor({
      command: process.execPath,
      entries: runtime,
      sharedEnv,
      backendEnv: {
        AUTH_TOKEN: authToken,
        PORT: "0",
        CDP_PORT,
      },
      forceElectronRunAsNode: true,
      hooks: {
        ...hooks,
        onStdoutLine: (source, line) => {
          hooks.onStdoutLine?.(source, line);
          if (source === "backend") relayWorkspaceProgress(line);
          if (!hooks.onStdoutLine && !app.isPackaged) console.log(`[${source}]`, line);
        },
        onStderrLine: (source, line) => {
          hooks.onStderrLine?.(source, line);
          if (!hooks.onStderrLine) console.error(`[${source}:stderr]`, line);
        },
        onExit: (source, code, signal) => {
          hooks.onExit?.(source, code, signal);
          if (!hooks.onExit) console.log(`[${source}] Exited with code=${code} signal=${signal}`);
        },
        onUnexpectedExit: () => scheduleRestart(hooks, createSupervisor),
      },
    });

  try {
    supervisor = createSupervisor();
    const { backendPort } = await supervisor.start();

    restartAttempt = 0;
    writeBackendPortFile(backendPort);
    return { port: backendPort, authToken };
  } catch (error) {
    await supervisor?.stop();
    throw error;
  }
}

export function stopBackend(): void {
  isQuitting = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  void supervisor?.stop();
}
