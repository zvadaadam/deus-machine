import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeSupervisor } from "./supervisor";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(runtimeDir, "../..");

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

  const supervisor = new RuntimeSupervisor({
    command: process.execPath,
    entries: {
      agentServerEntry: path.join(projectRoot, "apps", "agent-server", "dist", "index.bundled.cjs"),
      backendEntry: path.join(projectRoot, "apps", "backend", "server.cjs"),
      agentServerCwd: path.join(projectRoot, "apps", "agent-server"),
      backendCwd: path.join(projectRoot, "apps", "backend"),
    },
    backendEnv: { PORT: "0" },
    hooks: {
      onStdoutLine: (source, line) => log(`[${source}] ${line}`),
      onStderrLine: (source, line) => console.error(`[dev][${source}:stderr] ${line}`),
      onUnexpectedExit: (source, code, signal) => {
        console.error(
          `[dev] ${source} exited unexpectedly${signal ? ` (${signal})` : code ? ` (code ${code})` : ""}`
        );
        void supervisor.stop().finally(() => process.exit(1));
      },
    },
  });

  const { backendPort, agentServerUrl } = await supervisor.start();
  log(`Agent server ready at ${agentServerUrl}`);
  log(`Backend ready on port ${backendPort}`);

  const stop = (): void => {
    void supervisor.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const frontendCode = await spawnCommand("bun", ["run", "dev:frontend"], {
    VITE_BACKEND_PORT: String(backendPort),
  });
  await supervisor.stop();
  process.exit(frontendCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
