/**
 * Headless start mode — starts agent-server and backend.
 *
 * No web UI is served — remote users connect through app.deusmachine.ai via
 * the cloud relay. This keeps the headless CLI minimal.
 *
 * Process orchestration:
 * 1. Run onboarding (first run only — API key + remote access setup)
 * 2. Start agent-server → capture LISTEN_URL from stdout
 * 3. Start backend with AGENT_SERVER_URL → capture [BACKEND_PORT] from stdout
 * 4. Show pairing code + QR for remote access
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import {
  DEUS_DB_FILENAME,
  resolveDefaultDataDir,
  resolveRuntimeStagePaths,
} from "../../../shared/runtime";
import { validateRuntimeStage } from "../../../scripts/runtime/validate";
import {
  spinner as createSpinner,
  statusLine,
  c,
  sym,
  box,
  blank,
  sleep,
  success,
  error,
  warn,
  hint,
  kv,
  gradientText,
} from "./ui.js";
import { loadConfig, hasCompletedOnboarding, writeServerInfo, clearServerInfo } from "./config.js";
import { runOnboarding } from "./onboarding.js";
import { showPairCode } from "./pair.js";
import { formatUptime } from "./lib/format.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface StartOptions {
  dataDir?: string;
}

export async function start(options: StartOptions): Promise<void> {
  const { dataDir } = options;

  // ── Onboarding (first run only) ────────────────────────────────────
  if (!hasCompletedOnboarding()) {
    await runOnboarding();
    blank();
  }

  const config = loadConfig();

  // Resolve paths to bundles
  const paths = resolveBundlePaths();
  if (!paths) {
    error("Could not find Deus bundles.");
    blank();
    hint(`Run ${c.cyan("bun run build:cli")} from the monorepo root first.`);
    blank();
    process.exit(1);
  }

  // Resolve Node binary
  const nodeCmd = resolveNodeBinary();

  // Resolve database
  const dbPath = resolveDataDir(dataDir);
  kv("Database", c.dim(dbPath));
  blank();

  let backendProcess: ChildProcess | null = null;
  let status: ReturnType<typeof statusLine> | null = null;

  let shuttingDown = false;
  let exitCode = 0;
  function shutdown(code = 0) {
    if (shuttingDown) return; // Prevent double-shutdown from rapid Ctrl+C
    shuttingDown = true;
    exitCode = code;

    if (status) status.stop();
    blank();

    const msg = gradientText("Shutting down...", [167, 139, 250], [34, 211, 238]);
    console.log(`  ${msg}`);

    stopBackendProcess(backendProcess).finally(() => {
      backendProcess = null;
      clearServerInfo();
      blank();
      const bye = gradientText("Thanks for using Deus!", [167, 139, 250], [34, 211, 238]);
      console.log(`  ${bye}`);
      blank();
      process.exit(exitCode);
    });
  }
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  // Build extra env vars from config
  const extraEnv: Record<string, string> = {};
  if (config.auth_method === "api_key" && config.anthropic_api_key) {
    extraEnv.ANTHROPIC_API_KEY = config.anthropic_api_key;
  }

  const s1 = createSpinner("Starting backend...");
  const started = await startBackendProcess({
    command: nodeCmd,
    backendEntry: paths.backend,
    backendCwd: dirname(paths.backend),
    forceElectronRunAsNode: nodeCmd !== process.execPath,
    env: {
      DATABASE_PATH: dbPath,
      AGENT_SERVER_ENTRY: paths.agentServer,
      AGENT_SERVER_CWD: dirname(paths.agentServer),
      PORT: "0",
      ...extraEnv,
    },
    onUnexpectedExit: (code, signal) => {
      if (shuttingDown) return;
      blank();
      warn(`backend exited unexpectedly${signal ? ` (${signal})` : code ? ` (code ${code})` : ""}`);
      shutdown(1);
    },
  });

  if (!started) {
    s1.fail("Runtime failed to start");
    shutdown(1);
    return;
  }
  backendProcess = started.process;
  s1.succeed(`Runtime ${c.dim("ready")}`);
  const port = started.backendPort;

  // Write server info for `deus pair` and `deus status`
  writeServerInfo({
    pid: process.pid,
    backendPort: port,
    agentServerUrl: "managed-by-backend",
    startedAt: new Date().toISOString(),
  });

  // ── Ready ────────────────────────────────────────────────────────
  blank();
  box(
    [
      gradientText("Deus is running", [167, 139, 250], [34, 211, 238]),
      "",
      `API  ${c.dim(`http://localhost:${port}`)}`,
    ],
    { borderColor: c.cyan, width: 38 }
  );
  blank();

  // ── Pairing code (if relay enabled) ──────────────────────────────
  if (config.relay_enabled) {
    // Give the backend a moment to connect to the relay
    await sleep(1500);

    try {
      await showPairCode(port);
    } catch {
      blank();
      warn("Could not generate pairing code.");
      hint(`Run ${c.cyan("deus pair")} to try again once the relay connects.`);
      blank();
    }
  } else {
    blank();
    hint(`Remote access is disabled. Run ${c.cyan("deus login")} to re-run setup and enable it.`);
    blank();
  }

  // ── Status line ──────────────────────────────────────────────────
  blank();
  const startedAt = new Date();
  status = statusLine(() => {
    const elapsed = formatUptime(Date.now() - startedAt.getTime());
    return `${c.dim(`Running for ${elapsed}`)}  ${c.dim(`${sym.bullet} Ctrl+C to stop`)}`;
  }, 2000);

  // Keep the process alive
  await new Promise(() => {});
}

// ── Bundle resolution ────────────────────────────────────────────────

function resolveBundlePaths(): {
  agentServer: string;
  backend: string;
} | null {
  const cliRoot = resolve(__dirname, "..");

  // Bundled mode (npm package)
  const bundledDir = join(cliRoot, "bundles");
  if (existsSync(join(bundledDir, "agent-server.bundled.cjs"))) {
    return {
      agentServer: join(bundledDir, "agent-server.bundled.cjs"),
      backend: join(bundledDir, "server.bundled.cjs"),
    };
  }

  // Dev mode (monorepo)
  const monorepoRoot = resolve(cliRoot, "../..");
  const runtimePaths = resolveRuntimeStagePaths(monorepoRoot);

  try {
    validateRuntimeStage({ projectRoot: monorepoRoot, log: () => {} });
    return {
      agentServer: runtimePaths.common.agentServerBundle,
      backend: runtimePaths.common.backendBundle,
    };
  } catch (error) {
    warn(
      `Staged runtime is missing or stale in monorepo mode: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return null;
}

// ── Data directory ───────────────────────────────────────────────────

function resolveDataDir(customDir?: string): string {
  const dir =
    customDir ??
    resolveDefaultDataDir({
      platform: process.platform,
      homeDir: homedir(),
      appData: process.env.APPDATA,
      xdgDataHome: process.env.XDG_DATA_HOME,
    });

  mkdirSync(dir, { recursive: true });
  return join(dir, DEUS_DB_FILENAME);
}

// ── Node binary resolution ───────────────────────────────────────────

function resolveNodeBinary(): string {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return process.execPath;

  try {
    const electronPath = execSync(
      "node -e \"try { console.log(require('electron')) } catch { process.exit(1) }\"",
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (electronPath && existsSync(electronPath)) {
      try {
        execSync(
          "node -e \"const D = require('better-sqlite3'); const d = new D(':memory:'); d.close()\"",
          { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
        );
        return process.execPath;
      } catch {
        return electronPath;
      }
    }
  } catch {
    // ignore — fall through to default
  }

  return process.execPath;
}

async function startBackendProcess(opts: {
  command: string;
  backendEntry: string;
  backendCwd: string;
  env: Record<string, string>;
  forceElectronRunAsNode: boolean;
  onUnexpectedExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}): Promise<{ process: ChildProcess; backendPort: number } | null> {
  const { command, backendEntry, backendCwd, env, forceElectronRunAsNode, onUnexpectedExit } = opts;

  return new Promise((resolve) => {
    const child = spawn(command, [backendEntry], {
      cwd: backendCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(forceElectronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...env,
      },
    });

    let buffer = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        resolve(null);
      }
    }, 30_000);

    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(data);
      buffer += data.toString();
      const match = buffer.match(/^\[BACKEND_PORT\](\d+)$/m);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ process: child, backendPort: parseInt(match[1], 10) });
      }
    });

    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));

    child.on("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
        return;
      }
      onUnexpectedExit(code, signal);
    });
  });
}

function stopBackendProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      resolve();
    };

    child.once("exit", finish);
    child.kill("SIGTERM");

    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
  });
}
