/**
 * Headless start mode — starts the backend, which runs the agent engine.
 *
 * No web UI is served — remote users connect through app.deusmachine.ai via
 * the cloud relay. This keeps the headless CLI minimal.
 *
 * Process orchestration:
 * 1. Run onboarding (first run only — API key + remote access setup)
 * 2. Start the backend → capture [BACKEND_PORT] from stdout
 * 3. Show pairing code + QR for remote access
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  BACKEND_SHUTDOWN_TIMEOUT_MS,
  DEUS_DB_FILENAME,
  resolveDefaultDataDir,
  resolveRuntimeStagePaths,
} from "../../../shared/runtime";
import {
  spinner as createSpinner,
  statusLine,
  c,
  sym,
  box,
  blank,
  sleep,
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

  const cliRoot = fileURLToPath(new URL("../", import.meta.url));
  // build:cli copies the bundle here too. Only the checkout has the CLI source.
  const devRoot = existsSync(join(cliRoot, "src/start.ts")) ? resolve(cliRoot, "../..") : undefined;
  const bundled = join(cliRoot, "bundles", "server.bundled.cjs");
  const backend =
    devRoot && !existsSync(bundled)
      ? resolveRuntimeStagePaths(devRoot).common.backendBundle
      : bundled;
  if (!existsSync(backend)) {
    error(`Could not find Deus backend: ${backend}`);
    blank();
    hint(`Run ${c.cyan("bun run build:cli")} from the monorepo root first.`);
    blank();
    process.exit(1);
  }

  // The backend runs on the Node that runs this CLI, and needs its SQLite.
  const sqliteFailure = sqliteLoadFailure();
  if (sqliteFailure) {
    error(`SQLite (better-sqlite3) does not load under Node ${process.version}: ${sqliteFailure}`);
    blank();
    hint(
      devRoot
        ? `Run ${c.cyan("bun run native:node")} from the monorepo root, then start again.`
        : `Reinstall Deus with ${c.cyan("npm install -g deus-machine")}, then start again.`
    );
    blank();
    process.exit(1);
  }

  // Resolve database
  const dbPath = resolve(
    dataDir ??
      resolveDefaultDataDir({
        platform: process.platform,
        homeDir: homedir(),
        xdgDataHome: process.env.XDG_DATA_HOME,
        devRoot,
      }),
    DEUS_DB_FILENAME
  );
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
    backendEntry: backend,
    backendCwd: dirname(backend),
    env: {
      DATABASE_PATH: dbPath,
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

// ── SQLite ───────────────────────────────────────────────────────────

/** Why better-sqlite3 cannot open a database under this Node, or null if it can. */
function sqliteLoadFailure(): string | null {
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (filename: string) => {
      close(): void;
    };
    new Database(":memory:").close();
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return message.split("\n")[0];
  }
}

// ── Backend process ──────────────────────────────────────────────────

async function startBackendProcess(opts: {
  backendEntry: string;
  backendCwd: string;
  env: Record<string, string>;
  onUnexpectedExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}): Promise<{ process: ChildProcess; backendPort: number } | null> {
  const { backendEntry, backendCwd, env, onUnexpectedExit } = opts;

  return new Promise((resolve) => {
    // The Node that runs this CLI runs the backend.
    const child = spawn(process.execPath, [backendEntry], {
      cwd: backendCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
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
    }, BACKEND_SHUTDOWN_TIMEOUT_MS);
  });
}
