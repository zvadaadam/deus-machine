import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const STARTUP_TIMEOUT_MS = 30_000;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".ps1", ".com"]);
const RUNTIME_AGENT_SERVER_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_BACKEND_PORT",
  "DEUS_DATA_DIR",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "NODE_PATH",
  "PORT",
] as const;

let child: ChildProcess | null = null;
let stopping = false;

function resolveAgentServerEntry(): string {
  if (process.env.AGENT_SERVER_ENTRY) return process.env.AGENT_SERVER_ENTRY;
  return path.join(process.cwd(), "apps", "agent-server", "dist", "index.bundled.cjs");
}

function resolveAgentServerCwd(entry: string): string {
  return process.env.AGENT_SERVER_CWD || path.dirname(entry);
}

function resolveRuntimeExecutable(): string | null {
  if (process.env.DEUS_RUNTIME_EXECUTABLE) return process.env.DEUS_RUNTIME_EXECUTABLE;
  return null;
}

function isPackagedBackend(): boolean {
  return process.env.DEUS_PACKAGED === "1";
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;
  if (process.platform === "win32") {
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }
  return (stat.mode & 0o111) !== 0;
}

export async function startManagedAgentServer(): Promise<string> {
  if (child && child.exitCode === null && child.signalCode === null) {
    throw new Error("agent-server is already running");
  }

  const runtimeExecutable = resolveRuntimeExecutable();
  if (!runtimeExecutable && isPackagedBackend()) {
    throw new Error(
      "Packaged backend requires DEUS_RUNTIME_EXECUTABLE; refusing Electron-as-Node agent-server fallback"
    );
  }
  const entry = runtimeExecutable ? null : resolveAgentServerEntry();
  if (runtimeExecutable) {
    if (!isExecutableFile(runtimeExecutable)) {
      throw new Error(`deus-runtime executable is missing or not executable: ${runtimeExecutable}`);
    }
  } else if (entry && !existsSync(entry)) {
    throw new Error(`Agent-server entry not found: ${entry}`);
  }

  const cwd = runtimeExecutable ? process.cwd() : resolveAgentServerCwd(entry!);
  mkdirSync(cwd, { recursive: true });
  stopping = false;

  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (runtimeExecutable) {
      for (const key of RUNTIME_AGENT_SERVER_ENV_DENYLIST) {
        delete childEnv[key];
      }
    } else {
      childEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    const agent = spawn(
      runtimeExecutable ?? process.execPath,
      runtimeExecutable ? ["agent-server"] : [entry!],
      {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child = agent;

    let settled = false;
    let stdoutBuffer = "";

    const timeout = setTimeout(() => {
      agent.kill("SIGTERM");
      fail(new Error(`Agent-server startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
    }, STARTUP_TIMEOUT_MS);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const succeed = (url: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(url);
    };

    agent.stdout?.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log(`[agent-server] ${trimmed}`);
        const match = trimmed.match(/LISTEN_URL=(.+)/);
        if (match) succeed(match[1]);
      }
    });

    agent.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) console.error(`[agent-server:stderr] ${trimmed}`);
      }
    });

    agent.on("exit", (code, signal) => {
      child = null;
      clearTimeout(timeout);
      console.log(`[agent-server] Exited with code=${code} signal=${signal}`);
      if (!settled) {
        fail(new Error(`Agent-server exited before starting (code=${code}, signal=${signal})`));
        return;
      }
      if (!stopping) {
        console.error("[agent-server] Exited unexpectedly; shutting down backend");
        process.exit(1);
      }
    });

    agent.on("error", (error) => {
      child = null;
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function stopManagedAgentServer(): Promise<void> {
  stopping = true;
  const target = child;
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    child = null;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      child = null;
      resolve();
    };

    target.once("exit", finish);
    target.kill("SIGTERM");

    const forceTimer = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) {
        target.kill("SIGKILL");
      }
    }, 5_000);
  });
}
