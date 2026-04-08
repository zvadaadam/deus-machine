/**
 * Runtime Process Manager
 *
 * Electron owns both runtime children explicitly:
 * 1. agent-server
 * 2. backend (connected via AGENT_SERVER_URL)
 *
 * This keeps desktop aligned with the CLI and dev launcher, and avoids
 * backend-specific child-process branching in production.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";
import { DEUS_DB_FILENAME } from "../../../shared/runtime";

export const CDP_PORT = "19222";

type RuntimeProcessName = "backend" | "agent-server";

let backendProcess: ChildProcess | null = null;
let agentServerProcess: ChildProcess | null = null;
let isQuitting = false;
let startupInProgress = false;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const expectedExitPids = new Set<number>();
const MAX_RESTART_ATTEMPTS = 5;
const STARTUP_TIMEOUT_MS = 30_000;

export interface BackendSpawnHooks {
  onStdoutLine?: (source: RuntimeProcessName, line: string) => void;
  onStderrLine?: (source: RuntimeProcessName, line: string) => void;
  onExit?: (source: RuntimeProcessName, code: number | null, signal: NodeJS.Signals | null) => void;
}

interface RuntimeEntries {
  backendEntry: string;
  agentServerEntry: string;
  backendCwd: string;
  agentServerCwd: string;
  nodePath?: string;
}

function resolveRuntimeEntries(): RuntimeEntries {
  const projectRoot = join(__dirname, "../..");

  if (app.isPackaged) {
    return {
      backendEntry: join(process.resourcesPath, "backend", "server.bundled.cjs"),
      agentServerEntry: join(process.resourcesPath, "bin", "index.bundled.cjs"),
      backendCwd: app.getPath("userData"),
      agentServerCwd: app.getPath("userData"),
      nodePath: join(process.resourcesPath, "app.asar", "node_modules"),
    };
  }

  return {
    backendEntry: join(projectRoot, "apps/backend/server.cjs"),
    agentServerEntry: join(projectRoot, "apps/agent-server/dist/index.bundled.cjs"),
    backendCwd: join(projectRoot, "apps/backend"),
    agentServerCwd: join(projectRoot, "apps/agent-server"),
  };
}

function prettyProcessName(name: RuntimeProcessName): string {
  return name === "agent-server" ? "Agent server" : "Backend";
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

function markExpectedExit(child: ChildProcess | null): void {
  if (child?.pid) {
    expectedExitPids.add(child.pid);
  }
}

function consumeExpectedExit(child: ChildProcess): boolean {
  return child.pid != null ? expectedExitPids.delete(child.pid) : false;
}

function clearProcessRef(name: RuntimeProcessName, child: ChildProcess): void {
  if (name === "backend" && backendProcess === child) {
    backendProcess = null;
    return;
  }

  if (name === "agent-server" && agentServerProcess === child) {
    agentServerProcess = null;
  }
}

function terminateManagedProcess(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  markExpectedExit(child);
  child.kill("SIGTERM");

  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5_000);

  child.once("exit", () => {
    clearTimeout(forceTimer);
  });
}

function stopRuntimeChildren(): void {
  terminateManagedProcess(backendProcess);
  terminateManagedProcess(agentServerProcess);
}

function scheduleRestart(hooks: BackendSpawnHooks): void {
  if (isQuitting || startupInProgress || restartTimer || restartAttempt >= MAX_RESTART_ATTEMPTS) {
    return;
  }

  restartAttempt++;
  const delay = Math.min(1000 * Math.pow(2, restartAttempt - 1), 30_000);
  console.log(`[runtime] Restart attempt ${restartAttempt} in ${delay}ms`);

  stopRuntimeChildren();

  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnBackend(hooks)
      .then(({ port, authToken }) => {
        process.env.DEUS_BACKEND_PORT = String(port);
        process.env.DEUS_AUTH_TOKEN = authToken;

        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("backend:port-changed", { port });
        }
        console.log(`[runtime] Restarted on port ${port}, notified renderer`);
      })
      .catch((err) => {
        console.error("[runtime] Restart failed:", err);
      });
  }, delay);
}

async function startManagedProcess(opts: {
  name: RuntimeProcessName;
  entry: string;
  cwd: string;
  env: Record<string, string>;
  waitFor: RegExp;
  hooks: BackendSpawnHooks;
}): Promise<{ child: ChildProcess; value: string }> {
  const { name, entry, cwd, env, waitFor, hooks } = opts;

  if (!existsSync(entry)) {
    throw new Error(`${prettyProcessName(name)} entry not found: ${entry}`);
  }

  mkdirSync(cwd, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutBuffer = "";

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const succeed = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ child, value });
    };

    const timeout = setTimeout(() => {
      markExpectedExit(child);
      child.kill("SIGTERM");
      fail(new Error(`${prettyProcessName(name)} startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
    }, STARTUP_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        hooks.onStdoutLine?.(name, trimmed);

        if (!app.isPackaged) {
          console.log(`[${name}]`, trimmed);
        }

        if (name === "backend") {
          relayWorkspaceProgress(trimmed);
        }

        const match = trimmed.match(waitFor);
        if (match) {
          succeed(match[1]);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        hooks.onStderrLine?.(name, trimmed);
        console.error(`[${name}:stderr]`, trimmed);
      }
    });

    child.on("exit", (code, signal) => {
      const expected = consumeExpectedExit(child);
      hooks.onExit?.(name, code, signal);
      clearProcessRef(name, child);
      console.log(`[${name}] Exited with code=${code} signal=${signal}`);

      if (!settled) {
        fail(
          new Error(
            `${prettyProcessName(name)} exited before starting (code=${code}, signal=${signal})`
          )
        );
        return;
      }

      if (!expected && !isQuitting) {
        scheduleRestart(hooks);
      }
    });

    child.on("error", (err) => {
      console.error(`[${name}] Spawn error:`, err);
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function spawnBackend(
  hooks: BackendSpawnHooks = {}
): Promise<{ port: number; authToken: string }> {
  const authToken = crypto.randomBytes(24).toString("hex");
  const runtime = resolveRuntimeEntries();
  const dbPath = join(app.getPath("userData"), DEUS_DB_FILENAME);

  const sharedEnv = {
    DATABASE_PATH: dbPath,
    ...(runtime.nodePath ? { NODE_PATH: runtime.nodePath } : {}),
  };

  startupInProgress = true;

  try {
    const { child: agentChild, value: agentServerUrl } = await startManagedProcess({
      name: "agent-server",
      entry: runtime.agentServerEntry,
      cwd: runtime.agentServerCwd,
      env: sharedEnv,
      waitFor: /LISTEN_URL=(.+)/,
      hooks,
    });
    agentServerProcess = agentChild;

    const { child: backendChild, value: backendPortValue } = await startManagedProcess({
      name: "backend",
      entry: runtime.backendEntry,
      cwd: runtime.backendCwd,
      env: {
        ...sharedEnv,
        AGENT_SERVER_URL: agentServerUrl,
        AUTH_TOKEN: authToken,
        PORT: "0",
        CDP_PORT,
      },
      waitFor: /^\[BACKEND_PORT\](\d+)$/,
      hooks,
    });
    backendProcess = backendChild;

    restartAttempt = 0;
    const port = parseInt(backendPortValue, 10);
    writeBackendPortFile(port);
    return { port, authToken };
  } catch (error) {
    stopRuntimeChildren();
    throw error;
  } finally {
    startupInProgress = false;
  }
}

export function stopBackend(): void {
  isQuitting = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  stopRuntimeChildren();
}
