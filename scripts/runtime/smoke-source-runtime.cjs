const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RUNTIME_ENTRY = path.join(PROJECT_ROOT, "apps", "runtime", "index.ts");
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const BUNDLED_AGENT_CLI_PATTERNS = [
  /BUNDLED_CLI_PATH claude=.*\/claude/,
  /BUNDLED_CLI_PATH codex=.*\/codex/,
];

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

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        timeout: 5_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, body });
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`Timed out requesting ${pathname}`)));
  });
}

async function assertBackendDbRoute(port) {
  const response = await getJson(port, "/api/workspaces");
  if (response.statusCode !== 200) {
    throw new Error(
      `Backend DB route failed: GET /api/workspaces returned ${response.statusCode}: ${response.body.slice(
        0,
        500
      )}`
    );
  }

  const parsed = JSON.parse(response.body);
  if (!Array.isArray(parsed)) {
    throw new Error(`Backend DB route returned non-array payload: ${response.body.slice(0, 500)}`);
  }
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
  let output = "";
  let matchedValue = null;
  let settled = false;

  try {
    const value = await new Promise((resolve, reject) => {
      const missingRequiredPatterns = () =>
        (options.requiredPatterns || [])
          .filter((pattern) => !pattern.test(output))
          .map((pattern) => pattern.toString());
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for bun apps/runtime/index.ts ${args.join(
              " "
            )}. missing=${missingRequiredPatterns().join(", ") || "none"} stdout=${output
              .trim()
              .slice(-4000)} stderr=${stderrBuffer.trim().slice(-4000)}`
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
        Promise.resolve(options.onReady?.(match, output))
          .then(() => resolve(match))
          .catch(reject);
      };
      const maybeSucceed = () => {
        if (matchedValue === null) return;
        for (const pattern of options.requiredPatterns || []) {
          if (!pattern.test(output)) return;
        }
        succeed(matchedValue);
      };

      child.stdout.on("data", (data) => {
        const chunk = data.toString();
        output += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const match = matcher(line.trim());
          if (match) matchedValue = match;
        }
        maybeSucceed();
      });

      child.stderr.on("data", (data) => {
        const chunk = data.toString();
        output += chunk;
        stderrBuffer += chunk;
        maybeSucceed();
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
  const nodePathEntries = String(selfTest.nodePath || "")
    .split(path.delimiter)
    .filter(Boolean);
  const nodeGlobalPaths = Array.isArray(selfTest.nodeGlobalPaths) ? selfTest.nodeGlobalPaths : [];
  for (const entry of nodePathEntries) {
    if (!nodeGlobalPaths.includes(entry)) {
      throw new Error(
        `Source runtime NODE_PATH entry is not active in module resolution: ${entry}`
      );
    }
  }
  console.log(`[runtime-source-smoke] self-test binDir: ${selfTest.binDir}`);

  const listenUrl = await waitForRuntimeLine(
    ["agent-server"],
    (line) => {
      const match = line.match(/LISTEN_URL=(.+)$/);
      return match ? match[1] : null;
    },
    {
      requiredPatterns: BUNDLED_AGENT_CLI_PATTERNS,
    }
  );
  console.log(`[runtime-source-smoke] agent-server resolved bundled CLIs: ${listenUrl}`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-runtime-source-"));
  try {
    const backendPort = await waitForRuntimeLine(
      ["backend", "--data-dir", dataDir],
      (line) => {
        const match = line.match(/^\[BACKEND_PORT\](\d+)$/);
        return match ? Number(match[1]) : null;
      },
      {
        env: {
          DEUS_DATA_DIR: dataDir,
          DATABASE_PATH: path.join(dataDir, "deus.db"),
        },
        requiredPatterns: [
          /^\[agent-server\] BUNDLED_CLI_PATH claude=.*\/claude/m,
          /^\[agent-server\] BUNDLED_CLI_PATH codex=.*\/codex/m,
        ],
        onReady: assertBackendDbRoute,
      }
    );
    console.log(
      `[runtime-source-smoke] backend resolved bundled CLIs and served DB route: ${backendPort}`
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
