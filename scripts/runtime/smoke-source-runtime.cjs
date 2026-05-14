const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RUNTIME_ENTRY = path.join(PROJECT_ROOT, "apps", "runtime", "index.ts");
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

function runRuntime(args) {
  const result = spawnSync("bun", [RUNTIME_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: STARTUP_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `bun apps/runtime/index.ts ${args.join(" ")} failed with status ${result.status}: ${
        result.stderr || result.stdout
      }`
    );
  }
  return result.stdout.trim();
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

async function waitForRuntimeLine(args, matcher, options = {}) {
  const child = spawn("bun", [RUNTIME_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;

  try {
    const value = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for bun apps/runtime/index.ts ${args.join(
              " "
            )}. stderr: ${stderrBuffer.trim()}`
          )
        );
      }, STARTUP_TIMEOUT_MS);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const succeed = (match) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(match);
      };

      child.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const match = matcher(line.trim());
          if (match) succeed(match);
        }
      });

      child.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
      });

      child.on("error", fail);
      child.on("exit", (code, signal) => {
        if (!settled) {
          fail(
            new Error(
              `Runtime command exited before readiness (code=${code}, signal=${signal}). stderr: ${stderrBuffer.trim()}`
            )
          );
        }
      });
    });
    return value;
  } finally {
    await stopChild(child);
  }
}

async function main() {
  const version = runRuntime(["--version"]);
  if (!/^deus-runtime \d+\.\d+\.\d+ /.test(version)) {
    throw new Error(`Unexpected source runtime version output: ${version}`);
  }
  console.log(`[runtime-source-smoke] version: ${version}`);

  const selfTest = JSON.parse(runRuntime(["self-test"]));
  if (selfTest.ok !== true) {
    throw new Error(`Source runtime self-test failed: ${JSON.stringify(selfTest)}`);
  }
  console.log(`[runtime-source-smoke] self-test binDir: ${selfTest.binDir}`);

  const listenUrl = await waitForRuntimeLine(["agent-server"], (line) => {
    const match = line.match(/LISTEN_URL=(.+)$/);
    return match ? match[1] : null;
  });
  console.log(`[runtime-source-smoke] agent-server: ${listenUrl}`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-runtime-source-"));
  try {
    const backendPort = await waitForRuntimeLine(
      ["backend", "--data-dir", dataDir],
      (line) => {
        const match = line.match(/^\[BACKEND_PORT\](\d+)$/);
        return match ? match[1] : null;
      },
      {
        env: {
          DEUS_DATA_DIR: dataDir,
          DATABASE_PATH: path.join(dataDir, "deus.db"),
        },
      }
    );
    console.log(`[runtime-source-smoke] backend: ${backendPort}`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
