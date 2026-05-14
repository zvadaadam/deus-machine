const { spawn } = require("node:child_process");
const path = require("node:path");

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const timeoutMs = parsePositiveInteger(process.env.DEUS_VERSION_CHECK_TIMEOUT_MS, 20_000);
const stopTimeoutMs = parsePositiveInteger(process.env.DEUS_VERSION_CHECK_STOP_TIMEOUT_MS, 5_000);
const VERSION_CHECK_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BACKEND_PORT",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_DATA_DIR",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "PORT",
];

function versionCheckEnv() {
  const env = { ...process.env };
  for (const key of VERSION_CHECK_ENV_DENYLIST) {
    delete env[key];
  }
  return env;
}

function writeResult(result, exitCode) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function killChildTree(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if process-group termination is unavailable.
    }
  }
  child.kill(signal);
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
      if (child.exitCode === null && child.signalCode === null) killChildTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      finish();
    }, stopTimeoutMs);
    child.once("exit", finish);
    killChildTree(child, "SIGTERM");
  });
}

async function main() {
  const [executablePath, ...args] = process.argv.slice(2);
  if (!executablePath) {
    writeResult({ ok: false, error: "missing executable path", stdout: "", stderr: "" }, 2);
    return;
  }
  const resolvedExecutablePath = path.resolve(executablePath);

  const child = spawn(resolvedExecutablePath, args, {
    cwd: path.dirname(resolvedExecutablePath),
    detached: process.platform !== "win32",
    env: versionCheckEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        reject(Object.assign(new Error("timeout"), { timedOut: true }));
      }, timeoutMs);

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        finish(() => reject(error));
      });
      child.on("exit", (code, signal) => {
        finish(() => resolve({ code, signal }));
      });
    }).then((result) => {
      const { code, signal } = result;
      writeResult(
        {
          ok: code === 0,
          status: code,
          signal,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        },
        code === 0 ? 0 : 1
      );
    });
  } catch (error) {
    await stopChild(child);
    writeResult(
      {
        ok: false,
        timedOut: error && error.timedOut === true,
        error:
          error && error.code ? error.code : error instanceof Error ? error.message : String(error),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      },
      error && error.timedOut === true ? 124 : 1
    );
  }
}

main().catch((error) => {
  writeResult(
    {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: "",
      stderr: "",
    },
    1
  );
});
