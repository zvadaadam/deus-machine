import { spawn, type ChildProcess } from "child_process";
import { pushCloudCredentialsToBackend } from "./deus-cloud-provision";
import { existsSync, statSync, writeFileSync } from "fs";
import { delimiter, extname, join } from "path";
import { app, BrowserWindow } from "electron";
import crypto from "crypto";
import { DEUS_DB_FILENAME, PACKAGED_SYSTEM_PATHS } from "../../../shared/runtime";
import { extendCliPath, getDevStagedCliDirectory } from "../../../shared/lib/cli-path";
import { PACKAGED_RUNTIME_ENV_DENYLIST } from "./runtime-env";
import { handleKeepAwakeLine, setKeepAwakeWanted } from "./keep-awake";
import { getLaunchPath } from "./shell-env";
import { rendererOrigin } from "./app-protocol";
import { WEB_ORIGINS_ENV } from "../../../shared/web-origins";

let backendProcess: ChildProcess | null = null;
let isQuitting = false;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
// Restarts are counted until a backend has stayed up this long, so one that
// starts and then keeps crashing stops after MAX_RESTART_ATTEMPTS.
let stableTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTART_ATTEMPTS = 5;
const STABLE_UPTIME_MS = 60_000;
const STARTUP_TIMEOUT_MS = 30_000;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".ps1", ".com"]);

export interface BackendSpawnHooks {
  /** Each backend that starts, the first and every restart, with its port. */
  onReady?: (port: number) => void;
  onStdoutLine?: (source: "backend", line: string) => void;
  onStderrLine?: (source: "backend", line: string) => void;
  onExit?: (source: "backend", code: number | null, signal: NodeJS.Signals | null) => void;
}

interface ElectronRuntimeEntries {
  backendEntry?: string;
  backendCwd: string;
  resourcesPath?: string;
  bundledBinDir?: string;
  runtimeExecutable?: string;
}

function resolveRuntimeEntries(): ElectronRuntimeEntries {
  const projectRoot = join(__dirname, "../..");

  if (app.isPackaged) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Packaged Deus runtime is currently only staged for macOS and Linux");
    }
    return {
      backendCwd: app.getPath("userData"),
      resourcesPath: process.resourcesPath,
      bundledBinDir: join(process.resourcesPath, "bin"),
      runtimeExecutable: join(process.resourcesPath, "bin", "deus-runtime"),
    };
  }

  return {
    backendEntry: join(projectRoot, "apps/backend/server.cjs"),
    backendCwd: join(projectRoot, "apps/backend"),
    bundledBinDir: getDevStagedCliDirectory(projectRoot) ?? undefined,
  };
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

function buildRuntimePath(runtime: ElectronRuntimeEntries): string {
  if (runtime.runtimeExecutable && runtime.bundledBinDir) {
    return [runtime.bundledBinDir, ...PACKAGED_SYSTEM_PATHS].join(delimiter);
  }
  return [runtime.bundledBinDir, extendCliPath(process.env.PATH)].filter(Boolean).join(delimiter);
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;
  if (process.platform === "win32") {
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(filePath).toLowerCase());
  }
  return (stat.mode & 0o111) !== 0;
}

/** The `node` the dev backend runs on: the first found on these PATHs, in order. */
function findDevNode(...searchPaths: string[]): string {
  for (const searchPath of searchPaths) {
    for (const dir of searchPath.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, process.platform === "win32" ? "node.exe" : "node");
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  throw new Error(
    "The dev backend runs on Node.js, and no `node` is on the PATH. " +
      "Install Node 22 (brew install node@22 && brew link --overwrite --force node@22, " +
      "or a version manager that reads .node-version), then run `bun run dev` again. " +
      "`bun run doctor` checks the rest."
  );
}

function terminateBackend(): Promise<void> {
  const child = backendProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    backendProcess = null;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (backendProcess === child) backendProcess = null;
      resolve();
    };

    child.once("exit", finish);
    child.kill("SIGTERM");

    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  });
}

function clearStableTimer(): void {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = null;
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
        const { port, authToken } = await spawnBackend(hooks);
        process.env.DEUS_BACKEND_PORT = String(port);
        // The new backend accepts credentials only with its own spawn token.
        process.env.DEUS_AUTH_TOKEN = authToken;

        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("backend:port-changed", { port });
        }
        // A restarted backend starts with no cloud credentials: they live in
        // safeStorage and reach it only over the runtime route (deliberately
        // NOT the spawn env, so sign-out can retract them). Without this the
        // cloud lane silently stays disabled until the app is relaunched.
        void pushCloudCredentialsToBackend().catch(() => {});
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
  if (runtime.runtimeExecutable && !isExecutableFile(runtime.runtimeExecutable)) {
    throw new Error(
      `deus-runtime executable is missing or not executable: ${runtime.runtimeExecutable}`
    );
  }
  // Dev only: an explicit DATABASE_PATH wins — the isolation seam the backend
  // already honors, so a worktree dev run can point at a scratch database
  // instead of the real userData one (whose schema may not match the branch).
  // A PACKAGED app never honors it: stray shell env must not redirect the
  // real database (same doctrine as PACKAGED_RUNTIME_ENV_DENYLIST).
  const dbPath =
    (!app.isPackaged && process.env.DATABASE_PATH) ||
    join(app.getPath("userData"), DEUS_DB_FILENAME);

  const sharedEnv: NodeJS.ProcessEnv = {
    DATABASE_PATH: dbPath,
    PATH: buildRuntimePath(runtime),
    ...(runtime.resourcesPath
      ? { DEUS_PACKAGED: "1", DEUS_RESOURCES_PATH: runtime.resourcesPath }
      : {}),
    ...(runtime.runtimeExecutable ? { DEUS_RUNTIME_EXECUTABLE: runtime.runtimeExecutable } : {}),
    ...(runtime.bundledBinDir ? { DEUS_BUNDLED_BIN_DIR: runtime.bundledBinDir } : {}),
  };
  if (runtime.runtimeExecutable) {
    sharedEnv.NODE_ENV = "production";
  }
  // Packaged: the bundled deus-runtime. Dev: the backend runs on the system
  // Node, as `bun run dev:web` and the tests do, so the native modules are
  // built once, for that Node (`bun run native:node`), never for Electron.
  // That is the terminal's `node`, so the PATH the app started with is
  // searched first: the login shell's PATH (shell sync) may put another Node
  // ahead. An app started from Finder has none there and uses the synced PATH.
  const backendCommand = runtime.runtimeExecutable ?? findDevNode(getLaunchPath(), sharedEnv.PATH!);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";

    const backendArgs = runtime.runtimeExecutable ? ["backend"] : [runtime.backendEntry!];

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (runtime.runtimeExecutable) {
      for (const key of PACKAGED_RUNTIME_ENV_DENYLIST) {
        delete childEnv[key];
      }
    }
    Object.assign(childEnv, sharedEnv, {
      AUTH_TOKEN: authToken,
      PORT: "0",
      // The one page that may use the backend from this computer: the window's.
      [WEB_ORIGINS_ENV]: rendererOrigin({
        isDev: !app.isPackaged,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
      }),
      // With stdin a pipe this process holds, the backend stops when this
      // process ends, even by a crash or SIGKILL (apps/backend/src/lib/parent-stdin.ts).
      DEUS_STOP_ON_STDIN_END: "1",
    });

    const child = spawn(backendCommand, backendArgs, {
      cwd: runtime.backendCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
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
      clearStableTimer();
      stableTimer = setTimeout(() => {
        stableTimer = null;
        restartAttempt = 0;
      }, STABLE_UPTIME_MS);
      writeBackendPortFile(port);
      hooks.onReady?.(port);
      resolve({ port, authToken });
    };

    child.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // A keep-awake line is protocol, not log output.
        if (handleKeepAwakeLine(trimmed)) continue;
        hooks.onStdoutLine?.("backend", trimmed);
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
      // It did not stay up: the restarts it causes keep counting.
      clearStableTimer();
      // Its connections went with it; a restarted backend reports them again.
      setKeepAwakeWanted(false);
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

export function stopBackend(): Promise<void> {
  isQuitting = true;
  clearStableTimer();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  return terminateBackend();
}
