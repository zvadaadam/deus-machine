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

import { execSync } from "node:child_process";
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
import { validateRuntimeStage } from "../../runtime/validate";
import { RuntimeSupervisor } from "../../runtime/supervisor";
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

  let supervisor: RuntimeSupervisor | null = null;
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

    supervisor?.stop().finally(() => {
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

  const s1 = createSpinner("Starting runtime...");
  supervisor = new RuntimeSupervisor({
    command: nodeCmd,
    entries: {
      agentServerEntry: paths.agentServer,
      backendEntry: paths.backend,
      agentServerCwd: dirname(paths.agentServer),
      backendCwd: dirname(paths.backend),
    },
    sharedEnv: { DATABASE_PATH: dbPath, ...extraEnv },
    backendEnv: { PORT: "0" },
    forceElectronRunAsNode: nodeCmd !== process.execPath,
    hooks: {
      onUnexpectedExit: (source, code, signal) => {
        if (shuttingDown) return;
        blank();
        warn(
          `${source} exited unexpectedly${signal ? ` (${signal})` : code ? ` (code ${code})` : ""}`
        );
        shutdown(1);
      },
    },
  });

  let backendPort: number;
  let agentServerUrl: string;
  try {
    const started = await supervisor.start();
    backendPort = started.backendPort;
    agentServerUrl = started.agentServerUrl;
  } catch {
    s1.fail("Runtime failed to start");
    shutdown(1);
    return;
  }
  s1.succeed(`Runtime ${c.dim("ready")}`);
  const port = backendPort;

  // Write server info for `deus pair` and `deus status`
  writeServerInfo({
    pid: process.pid,
    backendPort: port,
    agentServerUrl,
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
