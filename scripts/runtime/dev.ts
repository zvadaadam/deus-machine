import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(runtimeDir, "../..");
let stopping = false;

function log(message: string): void {
  console.log(`[dev] ${message}`);
}

function spawnCommand(
  command: string,
  args: string[],
  env: Record<string, string>
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function getHostRuntimeKey(): string | null {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }
  return null;
}

async function ensureAgentServerBundle(): Promise<void> {
  const bundlePath = path.join(projectRoot, "apps", "agent-server", "dist", "index.bundled.cjs");
  if (existsSync(bundlePath)) return;

  log("Building agent-server bundle...");
  const code = await spawnCommand("bun", ["run", "build:agent-server"], {});
  if (code !== 0) {
    throw new Error(`build:agent-server failed with code ${code}`);
  }
}

async function main(): Promise<void> {
  log("Starting Deus web development runtime");
  await ensureAgentServerBundle();

  const backend = await startBackend();
  if (!backend) {
    throw new Error("Backend failed to start");
  }

  const stop = (): void => {
    stopping = true;
    void stopBackend(backend.process).finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const frontendCode = await spawnCommand("bun", ["run", "dev:frontend"], {
    VITE_BACKEND_PORT: String(backend.port),
  });
  stopping = true;
  await stopBackend(backend.process);
  process.exit(frontendCode);
}

function startBackend(): Promise<{ process: ChildProcess; port: number } | null> {
  const runtimeKey = getHostRuntimeKey();

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(projectRoot, "apps", "backend", "server.cjs")],
      {
        cwd: path.join(projectRoot, "apps", "backend"),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: "0",
          AGENT_SERVER_ENTRY: path.join(
            projectRoot,
            "apps",
            "agent-server",
            "dist",
            "index.bundled.cjs"
          ),
          AGENT_SERVER_CWD: path.join(projectRoot, "apps", "agent-server"),
          DEUS_PROJECT_ROOT: projectRoot,
          ...(runtimeKey
            ? {
                DEUS_BUNDLED_BIN_DIR: path.join(
                  projectRoot,
                  "dist",
                  "runtime",
                  "electron",
                  "bin",
                  runtimeKey
                ),
              }
            : {}),
        },
      }
    );

    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(null);
    }, 30_000);

    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(data);
      buffer += data.toString();
      const match = buffer.match(/^\[BACKEND_PORT\](\d+)$/m);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        const port = parseInt(match[1], 10);
        log(`Backend ready on port ${port}`);
        resolve({ process: child, port });
      }
    });

    child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
    child.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(null);
        return;
      }
      if (!stopping) {
        console.error(
          `[dev] backend exited unexpectedly${signal ? ` (${signal})` : code ? ` (code ${code})` : ""}`
        );
        process.exit(1);
      }
    });
  });
}

function stopBackend(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
