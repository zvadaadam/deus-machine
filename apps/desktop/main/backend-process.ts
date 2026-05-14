import { spawn, type ChildProcess } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";
import { DEUS_DB_FILENAME } from "../../../shared/runtime";
import { extendCliPath } from "../../../shared/lib/cli-path";

export const CDP_PORT = "19222";

let backendProcess: ChildProcess | null = null;
let isQuitting = false;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTART_ATTEMPTS = 5;
const STARTUP_TIMEOUT_MS = 30_000;

export interface BackendSpawnHooks {
  onStdoutLine?: (source: "backend", line: string) => void;
  onStderrLine?: (source: "backend", line: string) => void;
  onExit?: (source: "backend", code: number | null, signal: NodeJS.Signals | null) => void;
}

interface ElectronRuntimeEntries {
  backendEntry: string;
  backendCwd: string;
  agentServerEntry: string;
  agentServerCwd: string;
  projectRoot?: string;
  resourcesPath?: string;
  nodePath?: string;
  bundledBinDir?: string;
}

function getHostRuntimeKey(): string | null {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }
  return null;
}

function resolveRuntimeEntries(): ElectronRuntimeEntries {
  const projectRoot = join(__dirname, "../..");
  const runtimeKey = getHostRuntimeKey();

  if (app.isPackaged) {
    return {
      backendEntry: join(process.resourcesPath, "backend", "server.bundled.cjs"),
      backendCwd: app.getPath("userData"),
      agentServerEntry: join(process.resourcesPath, "bin", "index.bundled.cjs"),
      agentServerCwd: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
      nodePath: join(process.resourcesPath, "app.asar", "node_modules"),
      bundledBinDir: join(process.resourcesPath, "bin"),
    };
  }

  return {
    backendEntry: join(projectRoot, "apps/backend/server.cjs"),
    backendCwd: join(projectRoot, "apps/backend"),
    agentServerEntry: join(projectRoot, "apps/agent-server/dist/index.bundled.cjs"),
    agentServerCwd: join(projectRoot, "apps/agent-server"),
    projectRoot,
    bundledBinDir: runtimeKey
      ? join(projectRoot, "dist/runtime/electron/bin", runtimeKey)
      : undefined,
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

function terminateBackend(): Promise<void> {
  const child = backendProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    backendProcess = null;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      if (backendProcess === child) backendProcess = null;
      resolve();
    };

    child.once("exit", finish);
    child.kill("SIGTERM");

    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  });
}

function scheduleRestart(hooks: BackendSpawnHooks): void {
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
        await terminateBackend();
        const { port } = await spawnBackend(hooks);
        process.env.DEUS_BACKEND_PORT = String(port);

        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("backend:port-changed", { port });
        }
        console.log(`[runtime] Restarted on port ${port}, notified renderer`);
      } catch (err) {
        console.error("[runtime] Restart failed:", err);
        scheduleRestart(hooks);
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
    AGENT_SERVER_ENTRY: runtime.agentServerEntry,
    AGENT_SERVER_CWD: runtime.agentServerCwd,
    ...(runtime.projectRoot ? { DEUS_PROJECT_ROOT: runtime.projectRoot } : {}),
    ...(runtime.nodePath ? { NODE_PATH: runtime.nodePath } : {}),
    ...(runtime.bundledBinDir ? { DEUS_BUNDLED_BIN_DIR: runtime.bundledBinDir } : {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";

    const child = spawn(process.execPath, [runtime.backendEntry], {
      cwd: runtime.backendCwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...sharedEnv,
        AUTH_TOKEN: authToken,
        PORT: "0",
        CDP_PORT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    backendProcess = child;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error(`Backend startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
    }, STARTUP_TIMEOUT_MS);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void terminateBackend();
      reject(error);
    };

    const succeed = (port: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      restartAttempt = 0;
      writeBackendPortFile(port);
      resolve({ port, authToken });
    };

    child.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        hooks.onStdoutLine?.("backend", trimmed);
        relayWorkspaceProgress(trimmed);
        if (!hooks.onStdoutLine && !app.isPackaged) console.log("[backend]", trimmed);

        const match = trimmed.match(/^\[BACKEND_PORT\](\d+)$/);
        if (match) succeed(parseInt(match[1], 10));
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        hooks.onStderrLine?.("backend", trimmed);
        if (!hooks.onStderrLine) console.error("[backend:stderr]", trimmed);
      }
    });

    child.on("exit", (code, signal) => {
      if (backendProcess === child) backendProcess = null;
      clearTimeout(timeout);
      hooks.onExit?.("backend", code, signal);
      if (!hooks.onExit) console.log(`[backend] Exited with code=${code} signal=${signal}`);
      if (!settled) {
        fail(new Error(`Backend exited before starting (code=${code}, signal=${signal})`));
        return;
      }
      if (!isQuitting) scheduleRestart(hooks);
    });

    child.on("error", (error) => {
      if (backendProcess === child) backendProcess = null;
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function stopBackend(): void {
  isQuitting = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  void terminateBackend();
}
