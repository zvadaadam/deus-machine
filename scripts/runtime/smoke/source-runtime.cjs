const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { assertInitializedAgents, readAgentServerListenUrl } = require("./runtime-rpc.cjs");
const {
  PROJECT_ROOT,
  assertBackendDbRoute,
  runtimeEnv,
  stopChild,
} = require("./lib/smoke-helpers.cjs");

const RUNTIME_ENTRY = path.join(PROJECT_ROOT, "apps", "runtime", "index.ts");
const STARTUP_TIMEOUT_MS = 30_000;
const BUNDLED_AGENT_CLI_PATTERNS = [
  /BUNDLED_CLI_PATH claude=.*\/claude/,
  /BUNDLED_CLI_PATH codex=.*\/codex/,
];

function runRuntime(args) {
  const result = spawnSync("bun", [RUNTIME_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    env: runtimeEnv(null),
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

async function waitForRuntimeLine(args, matcher, options = {}) {
  const child = spawn("bun", [RUNTIME_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    env: runtimeEnv(null, options.env || {}),
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
  const pathEntries = String(selfTest.pathEnv || "")
    .split(path.delimiter)
    .filter(Boolean);
  if (!pathEntries.includes(String(selfTest.binDir))) {
    throw new Error(`Source runtime PATH is missing bundled bin dir: ${selfTest.pathEnv}`);
  }
  const nodeGlobalPaths = Array.isArray(selfTest.nodeGlobalPaths) ? selfTest.nodeGlobalPaths : [];
  for (const entry of nodePathEntries) {
    if (!nodeGlobalPaths.includes(entry)) {
      throw new Error(
        `Source runtime NODE_PATH entry is not active in module resolution: ${entry}`
      );
    }
  }
  console.log(`[runtime-source-smoke] self-test binDir: ${selfTest.binDir}`);

  const deviceUseVersion = runRuntime(["device-use", "--version"]);
  if (!/^device-use \d+\.\d+\.\d+/.test(deviceUseVersion)) {
    throw new Error(`Unexpected source runtime device-use output: ${deviceUseVersion}`);
  }
  console.log(`[runtime-source-smoke] device-use command: ${deviceUseVersion}`);

  const listenUrl = await waitForRuntimeLine(
    ["agent-server"],
    (line) => {
      const match = line.match(/LISTEN_URL=(.+)$/);
      return match ? match[1] : null;
    },
    {
      requiredPatterns: BUNDLED_AGENT_CLI_PATTERNS,
      onReady: (listenUrl) => assertInitializedAgents(listenUrl),
    }
  );
  console.log(
    `[runtime-source-smoke] agent-server resolved bundled CLIs and initialized agents: ${listenUrl}`
  );

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
        onReady: async (backendPort, output) => {
          await assertBackendDbRoute(backendPort);
          const agentServerListenUrl = readAgentServerListenUrl(output);
          if (!agentServerListenUrl) {
            throw new Error("Backend runtime output did not include agent-server LISTEN_URL");
          }
          await assertInitializedAgents(agentServerListenUrl);
        },
      }
    );
    console.log(
      `[runtime-source-smoke] backend resolved bundled CLIs, initialized agents, and served DB route: ${backendPort}`
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
