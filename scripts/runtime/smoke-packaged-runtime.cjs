const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { assertInitializedAgents, readAgentServerListenUrl } = require("./runtime-smoke-rpc.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
function resolveDefaultAppPath() {
  const candidates =
    process.arch === "arm64"
      ? ["mac-arm64", "mac"]
      : process.arch === "x64"
        ? ["mac-x64", "mac"]
        : ["mac"];

  for (const directory of candidates) {
    const appPath = path.join(PROJECT_ROOT, "dist-electron", directory, "Deus.app");
    if (fs.existsSync(appPath)) return appPath;
  }
  return path.join(PROJECT_ROOT, "dist-electron", candidates[0], "Deus.app");
}

const DEFAULT_APP_PATH = resolveDefaultAppPath();
const STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 5_000;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const RUNTIME_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_BACKEND_PORT",
  "DEUS_DATA_DIR",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_PACKAGED",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "DEUS_RESOURCES_PATH",
  "NODE_PATH",
  "PORT",
];
const OBSOLETE_RUNTIME_PATTERNS = [
  /spawn (codex|claude).*ENOENT/,
  /ELECTRON_RUN_AS_NODE/,
  /resources\/backend/,
  /AGENT_SERVER_ENTRY/,
  /global CLI/,
];
function parseArgs(argv) {
  const options = {
    appPath: null,
    requireGatekeeper: false,
    skipAppCheck: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--app") {
      options.appPath = argv[++index];
    } else if (arg === "--require-gatekeeper") {
      options.requireGatekeeper = true;
    } else if (arg === "--skip-app-check") {
      options.skipAppCheck = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.appPath) {
      options.appPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  options.appPath = path.resolve(options.appPath ?? DEFAULT_APP_PATH);
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/runtime/smoke-packaged-runtime.cjs [app-path]

Options:
  --app <path>             Path to the packaged .app bundle
  --require-gatekeeper     Require spctl execute assessment in the app check
  --skip-app-check         Skip smoke-packaged-app.cjs and only run runtime commands

This smoke executes the packaged Resources/bin/deus-runtime. It should be run
on notarized release artifacts or hosts that allow generated/copied Mach-O
binaries to launch directly.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExecutable(filePath, label) {
  assert(fs.existsSync(filePath), `Missing ${label}: ${filePath}`);
  const stat = fs.statSync(filePath);
  assert(stat.isFile(), `${label} is not a regular file: ${filePath}`);
  assert((stat.mode & 0o111) !== 0, `${label} is not executable: ${filePath}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bundledAgentCliPatterns(binDir) {
  return [
    new RegExp(`BUNDLED_CLI_PATH claude=${escapeRegExp(path.join(binDir, "claude"))}`),
    new RegExp(`BUNDLED_CLI_PATH codex=${escapeRegExp(path.join(binDir, "codex"))}`),
  ];
}

function assertHostRunnableArch(filePath) {
  if (process.platform !== "darwin") return;
  const expectedArch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : null;
  if (!expectedArch) return;

  const output = execFileSync("file", [filePath], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!output.includes(expectedArch)) {
    throw new Error(
      `Packaged runtime architecture does not match this host; expected ${expectedArch}: ${output}`
    );
  }
}

function runDiagnostic(command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) {
    return [result.error.code || result.error.message, output].filter(Boolean).join("\n");
  }
  if (result.status !== 0) {
    return output || `${command} exited with status ${result.status}`;
  }
  return output;
}

function runtimeDiagnostics(runtimeBin) {
  if (process.platform !== "darwin") return "";
  return [
    `file: ${runDiagnostic("file", [runtimeBin])}`,
    `codesign: ${runDiagnostic("codesign", ["-dv", "--verbose=4", runtimeBin])}`,
    `spctl: ${runDiagnostic("spctl", ["--assess", "--type", "execute", "--verbose=4", runtimeBin])}`,
    `xattr: ${runDiagnostic("xattr", ["-l", runtimeBin]) || "none"}`,
  ].join("\n");
}

function macExecutionPolicyHint(diagnostics) {
  if (process.platform !== "darwin") return "";
  if (!/spctl:[\s\S]*rejected/.test(diagnostics)) return "";
  if (!/com\.apple\.(provenance|quarantine)/.test(diagnostics)) return "";

  return [
    "",
    "macOS rejected this executable before user code reached readiness.",
    "If the process times out with no stdout/stderr, verify on a notarized artifact or a macOS host that allows generated/copied Mach-O binaries to launch.",
  ].join("\n");
}

function runtimeEnv(binDir) {
  const env = {
    ...process.env,
  };
  for (const key of RUNTIME_ENV_DENYLIST) {
    delete env[key];
  }
  env.DEUS_BUNDLED_BIN_DIR = binDir;
  env.PATH = [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter);
  return env;
}

function runAppCheck(appPath, options) {
  if (options.skipAppCheck) return;

  const args = [
    path.join(PROJECT_ROOT, "scripts", "runtime", "smoke-packaged-app.cjs"),
    "--app",
    appPath,
    "--run-version-checks",
  ];
  if (options.requireGatekeeper) args.push("--require-gatekeeper");

  execFileSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

async function runRuntime(runtimeBin, args, binDir) {
  const child = spawn(runtimeBin, args, {
    cwd: path.dirname(runtimeBin),
    detached: process.platform !== "win32",
    env: runtimeEnv(binDir),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        const diagnostics = runtimeDiagnostics(runtimeBin);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `${path.basename(runtimeBin)} ${args.join(
              " "
            )} timed out after ${STARTUP_TIMEOUT_MS}ms stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      }, STARTUP_TIMEOUT_MS);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        const diagnostics = runtimeDiagnostics(runtimeBin);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `${path.basename(runtimeBin)} ${args.join(" ")} failed to spawn: error=${
              error.code || error.message
            } stdout=${stdout.trim().slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        if (code === 0) {
          settled = true;
          clearTimeout(timeout);
          resolve(stdout.trim());
          return;
        }

        const diagnostics = runtimeDiagnostics(runtimeBin);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `${path.basename(runtimeBin)} ${args.join(
              " "
            )} failed: status=${code} signal=${signal ?? "none"} stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      });
    });
  } finally {
    await stopChild(child);
  }
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
    }, STOP_TIMEOUT_MS);
    child.once("exit", finish);
    killChildTree(child, "SIGTERM");
  });
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

async function assertBackendDbRoute(output) {
  const match = output.match(/^\[BACKEND_PORT\](\d+)/m);
  if (!match) throw new Error("Backend DB route check could not find [BACKEND_PORT]");

  const response = await getJson(Number(match[1]), "/api/workspaces");
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

async function waitForRuntimePatterns(runtimeBin, args, binDir, patterns, options = {}) {
  const child = spawn(runtimeBin, args, {
    cwd: path.dirname(runtimeBin),
    detached: process.platform !== "win32",
    env: runtimeEnv(binDir),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const matched = new Set();

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let completing = false;
      const timeout = setTimeout(() => {
        settled = true;
        const missing = patterns
          .filter((_, index) => !matched.has(index))
          .map((pattern) => pattern.toString());
        const diagnostics = runtimeDiagnostics(runtimeBin);
        const hint = macExecutionPolicyHint(diagnostics);
        reject(
          new Error(
            `${path.basename(runtimeBin)} ${args.join(
              " "
            )} did not reach readiness. missing=${missing.join(", ") || "none"} stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      }, STARTUP_TIMEOUT_MS);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const maybeDone = () => {
        if (settled || completing) return;
        if (matched.size !== patterns.length) return;
        completing = true;
        clearTimeout(timeout);
        Promise.resolve(options.onReady?.(`${stdout}\n${stderr}`))
          .then(() => {
            if (settled) return;
            settled = true;
            resolve();
          })
          .catch(fail);
      };
      const inspectOutput = () => {
        const output = `${stdout}\n${stderr}`;
        for (const pattern of OBSOLETE_RUNTIME_PATTERNS) {
          if (pattern.test(output)) {
            fail(new Error(`Packaged runtime smoke used obsolete runtime path: ${pattern}`));
            return;
          }
        }
        patterns.forEach((pattern, index) => {
          if (pattern.test(output)) matched.add(index);
        });
        maybeDone();
      };

      child.stdout.on("data", (data) => {
        stdout += data.toString();
        inspectOutput();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
        inspectOutput();
      });
      child.on("error", fail);
      child.on("exit", (code, signal) => {
        if (!settled && matched.size !== patterns.length) {
          const diagnostics = runtimeDiagnostics(runtimeBin);
          const hint = macExecutionPolicyHint(diagnostics);
          fail(
            new Error(
              `${path.basename(runtimeBin)} ${args.join(
                " "
              )} exited before readiness: code=${code} signal=${signal} stdout=${stdout
                .trim()
                .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
                diagnostics ? `\n${diagnostics}` : ""
              }${hint}`
            )
          );
        }
      });
    });
  } finally {
    await stopChild(child);
  }

  return stdout;
}

async function smokePackagedRuntime(options) {
  const appPath = options.appPath;
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const binDir = path.join(resourcesDir, "bin");
  const runtimeBin = path.join(binDir, "deus-runtime");
  assertExecutable(runtimeBin, "packaged Deus runtime");
  assertHostRunnableArch(runtimeBin);

  runAppCheck(appPath, options);

  const version = await runRuntime(runtimeBin, ["--version"], binDir);
  if (!/^deus-runtime \d+\.\d+\.\d+ /.test(version)) {
    throw new Error(`Unexpected packaged runtime version output: ${version}`);
  }
  console.log(`[runtime-smoke] packaged runtime version: ${version}`);

  const selfTest = JSON.parse(await runRuntime(runtimeBin, ["self-test"], binDir));
  if (selfTest.ok !== true) {
    throw new Error(`Packaged runtime self-test failed: ${JSON.stringify(selfTest)}`);
  }
  if (selfTest.nodeEnv !== "production") {
    throw new Error(
      `Packaged runtime self-test expected NODE_ENV=production: ${selfTest.nodeEnv}; selfTest=${JSON.stringify(
        selfTest
      )}`
    );
  }
  if (path.resolve(String(selfTest.binDir || "")) !== path.resolve(binDir)) {
    throw new Error(
      `Packaged runtime self-test resolved unexpected binDir: ${selfTest.binDir}; expected ${binDir}`
    );
  }
  const expectedRuntimePath = [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter);
  if (selfTest.pathEnv !== expectedRuntimePath) {
    throw new Error(
      `Packaged runtime self-test expected deterministic PATH ${expectedRuntimePath}: ${selfTest.pathEnv}`
    );
  }
  if (path.resolve(String(selfTest.resourcesPath || "")) !== path.resolve(resourcesDir)) {
    throw new Error(
      `Packaged runtime self-test resolved unexpected resourcesPath: ${selfTest.resourcesPath}; expected ${resourcesDir}`
    );
  }
  const expectedNodePath = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  const nodePathEntries = String(selfTest.nodePath || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  if (!nodePathEntries.includes(path.resolve(expectedNodePath))) {
    throw new Error(
      `Packaged runtime self-test NODE_PATH is missing ${expectedNodePath}: ${selfTest.nodePath}`
    );
  }
  console.log(`[runtime-smoke] packaged runtime self-test binDir: ${selfTest.binDir}`);

  const expectedBundledCliPatterns = bundledAgentCliPatterns(binDir);
  await waitForRuntimePatterns(
    runtimeBin,
    ["agent-server"],
    binDir,
    [...expectedBundledCliPatterns, /LISTEN_URL=/],
    {
      onReady: async (output) => {
        const listenUrl = readAgentServerListenUrl(output);
        if (!listenUrl) throw new Error("Packaged runtime output did not include LISTEN_URL");
        await assertInitializedAgents(listenUrl);
      },
    }
  );
  console.log(
    "[runtime-smoke] packaged runtime agent-server resolved bundled CLIs and initialized agents"
  );

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-packaged-runtime-"));
  try {
    await waitForRuntimePatterns(
      runtimeBin,
      ["backend", "--data-dir", dataDir],
      binDir,
      [
        ...expectedBundledCliPatterns.map(
          (pattern) => new RegExp(`^\\[agent-server\\] ${pattern.source}`, "m")
        ),
        /^\[agent-server\] LISTEN_URL=/m,
        /^\[BACKEND_PORT\]\d+/m,
      ],
      {
        onReady: async (output) => {
          await assertBackendDbRoute(output);
          const listenUrl = readAgentServerListenUrl(output);
          if (!listenUrl) {
            throw new Error(
              "Packaged backend runtime output did not include agent-server LISTEN_URL"
            );
          }
          await assertInitializedAgents(listenUrl);
        },
      }
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(
    "[runtime-smoke] packaged runtime backend resolved bundled CLIs, initialized agents, and served DB route"
  );
}

smokePackagedRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
