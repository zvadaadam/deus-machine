/**
 * Headless start mode — starts agent-server and backend.
 *
 * No web UI is served — remote users connect through app.rundeus.com via
 * the cloud relay. This keeps the headless CLI minimal.
 *
 * Process orchestration:
 * 1. Run onboarding (first run only — API key + remote access setup)
 * 2. Start agent-server → capture LISTEN_URL from stdout
 * 3. Start backend with AGENT_SERVER_URL → capture [BACKEND_PORT] from stdout
 * 4. Show pairing code + QR for remote access
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, homedir } from "node:os";
import { mkdirSync } from "node:fs";
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
import {
  loadConfig,
  hasCompletedOnboarding,
  writeServerInfo,
  clearServerInfo,
} from "./config.js";
import { runOnboarding } from "./onboarding.js";
import { showPairCode } from "./pair.js";
import { formatUptime } from "./lib/format.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface StartOptions {
  dataDir?: string;
}

interface ProcessInfo {
  process: ChildProcess;
  name: string;
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

  // Track child processes for cleanup
  const children: ProcessInfo[] = [];
  let status: ReturnType<typeof statusLine> | null = null;

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return; // Prevent double-shutdown from rapid Ctrl+C
    shuttingDown = true;

    if (status) status.stop();
    blank();

    const msg = gradientText("Shutting down...", [167, 139, 250], [34, 211, 238]);
    console.log(`  ${msg}`);

    // Send SIGTERM and wait for children to exit (up to 5s)
    const exitPromises: Promise<void>[] = [];
    for (const child of children) {
      if (!child.process.killed) {
        exitPromises.push(
          new Promise<void>((resolve) => {
            child.process.on("exit", resolve);
            child.process.kill("SIGTERM");
          })
        );
      }
    }

    const drainTimeout = setTimeout(() => {
      // Force kill after 5s if children haven't exited
      for (const child of children) {
        if (!child.process.killed) child.process.kill("SIGKILL");
      }
    }, 5000);

    Promise.all(exitPromises).finally(() => {
      clearTimeout(drainTimeout);
      clearServerInfo();
      blank();
      const bye = gradientText("Thanks for using Deus!", [167, 139, 250], [34, 211, 238]);
      console.log(`  ${bye}`);
      blank();
      process.exit(0);
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Build extra env vars from config
  const extraEnv: Record<string, string> = {};
  if (config.auth_method === "api_key" && config.anthropic_api_key) {
    extraEnv.ANTHROPIC_API_KEY = config.anthropic_api_key;
  }

  // ── Step 1: Agent server ─────────────────────────────────────────
  const s1 = createSpinner("Starting agent server...");
  const agentServerUrl = await startProcess({
    name: "agent-server",
    command: nodeCmd,
    args: [paths.agentServer],
    env: { DATABASE_PATH: dbPath, ...extraEnv },
    waitFor: /LISTEN_URL=(.+)/,
    children,
  });

  if (!agentServerUrl) {
    s1.fail("Agent server failed to start");
    blank();
    process.exit(1);
  }
  s1.succeed(`Agent server ${c.dim("ready")}`);

  // ── Step 2: Backend ──────────────────────────────────────────────
  const s2 = createSpinner("Starting backend...");
  const backendPort = await startProcess({
    name: "backend",
    command: nodeCmd,
    args: [paths.backend],
    env: {
      AGENT_SERVER_URL: agentServerUrl,
      DATABASE_PATH: dbPath,
      PORT: "0",
      ...extraEnv,
    },
    waitFor: /\[BACKEND_PORT\](\d+)/,
    children,
  });

  if (!backendPort) {
    s2.fail("Backend failed to start");
    blank();
    process.exit(1);
  }
  s2.succeed(`Backend ${c.dim("ready")}`);

  const port = parseInt(backendPort, 10);

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
    hint(`Remote access is disabled. Run ${c.cyan("deus pair")} to enable it.`);
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
  const agentServer = join(monorepoRoot, "apps/agent-server/dist/index.bundled.cjs");
  const backend = join(monorepoRoot, "apps/backend/dist/server.bundled.cjs");

  if (existsSync(agentServer) && existsSync(backend)) {
    return { agentServer, backend };
  }

  return null;
}

// ── Data directory ───────────────────────────────────────────────────

function resolveDataDir(customDir?: string): string {
  if (customDir) {
    mkdirSync(customDir, { recursive: true });
    return join(customDir, "deus.db");
  }

  const os = platform();
  let dir: string;

  if (os === "darwin") {
    dir = join(homedir(), "Library/Application Support/com.deus.app");
  } else if (os === "win32") {
    dir = join(process.env.APPDATA || join(homedir(), "AppData/Roaming"), "com.deus.app");
  } else {
    dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "deus");
  }

  mkdirSync(dir, { recursive: true });
  return join(dir, "deus.db");
}

// ── Node binary resolution ───────────────────────────────────────────

function resolveNodeBinary(): string {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return process.execPath;

  try {
    const electronPath = execSync(
      'node -e "try { console.log(require(\'electron\')) } catch { process.exit(1) }"',
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
  } catch {}

  return process.execPath;
}

// ── Process spawner ──────────────────────────────────────────────────

async function startProcess(opts: {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  waitFor: RegExp;
  children: ProcessInfo[];
  timeoutMs?: number;
}): Promise<string | null> {
  const { name, command, args, env, waitFor, children, timeoutMs = 15_000 } = opts;

  return new Promise((resolve) => {
    const processEnv: Record<string, string> = {};
    if (command !== process.execPath && command.includes("Electron")) {
      processEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...processEnv, ...env },
    });

    children.push({ process: child, name });

    let buffer = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    function onStdout(data: Buffer) {
      buffer += data.toString();
      const match = buffer.match(waitFor);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        // Stop listening and release the buffer — process may run for days
        child.stdout?.removeListener("data", onStdout);
        buffer = "";
        resolve(match[1]);
      }
    }

    child.stdout?.on("data", onStdout);

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

