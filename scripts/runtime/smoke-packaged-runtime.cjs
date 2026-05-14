const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_APP_PATH = path.join(PROJECT_ROOT, "dist-electron", "mac-arm64", "Deus.app");
const STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 5_000;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const RUNTIME_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_PACKAGED",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "DEUS_RESOURCES_PATH",
  "NODE_PATH",
];
const OBSOLETE_RUNTIME_PATTERNS = [
  /spawn (codex|claude).*ENOENT/,
  /ELECTRON_RUN_AS_NODE/,
  /resources\/backend/,
  /AGENT_SERVER_ENTRY/,
  /global CLI/,
];
const BUNDLED_AGENT_CLI_PATTERNS = [
  /BUNDLED_CLI_PATH claude=.*\/claude/,
  /BUNDLED_CLI_PATH codex=.*\/codex/,
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

function assertHostRunnableArch(filePath) {
  if (process.platform !== "darwin") return;
  const expectedArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : null;
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

function runtimeEnv(binDir) {
  const env = {
    ...process.env,
    PATH: [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter),
  };
  for (const key of RUNTIME_ENV_DENYLIST) {
    delete env[key];
  }
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

function runRuntime(runtimeBin, args, binDir) {
  const result = spawnSync(runtimeBin, args, {
    cwd: path.dirname(runtimeBin),
    encoding: "utf8",
    timeout: STARTUP_TIMEOUT_MS,
    env: runtimeEnv(binDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const diagnostics = runtimeDiagnostics(runtimeBin);
    throw new Error(
      `${path.basename(runtimeBin)} ${args.join(" ")} failed: status=${result.status} signal=${
        result.signal
      } error=${result.error?.code ?? "none"} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}${
        diagnostics ? `\n${diagnostics}` : ""
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
      if (child.exitCode === null && child.signalCode === null) killChildTree(child, "SIGKILL");
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
        reject(
          new Error(
            `${path.basename(runtimeBin)} ${args.join(
              " "
            )} did not reach readiness. missing=${missing.join(", ") || "none"} stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }`
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
          fail(
            new Error(
              `${path.basename(runtimeBin)} ${args.join(
                " "
              )} exited before readiness: code=${code} signal=${signal} stdout=${stdout
                .trim()
                .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
                diagnostics ? `\n${diagnostics}` : ""
              }`
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

  const version = runRuntime(runtimeBin, ["--version"], binDir);
  if (!/^deus-runtime \d+\.\d+\.\d+ /.test(version)) {
    throw new Error(`Unexpected packaged runtime version output: ${version}`);
  }
  console.log(`[runtime-smoke] packaged runtime version: ${version}`);

  const selfTest = JSON.parse(runRuntime(runtimeBin, ["self-test"], binDir));
  if (selfTest.ok !== true) {
    throw new Error(`Packaged runtime self-test failed: ${JSON.stringify(selfTest)}`);
  }
  console.log(`[runtime-smoke] packaged runtime self-test binDir: ${selfTest.binDir}`);

  await waitForRuntimePatterns(runtimeBin, ["agent-server"], binDir, [
    ...BUNDLED_AGENT_CLI_PATTERNS,
    /LISTEN_URL=/,
  ]);
  console.log(
    "[runtime-smoke] packaged runtime agent-server resolved bundled CLIs and reached LISTEN_URL"
  );

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-packaged-runtime-"));
  try {
    await waitForRuntimePatterns(
      runtimeBin,
      ["backend", "--data-dir", dataDir],
      binDir,
      [
        /^\[agent-server\] BUNDLED_CLI_PATH claude=.*\/claude/m,
        /^\[agent-server\] BUNDLED_CLI_PATH codex=.*\/codex/m,
        /^\[agent-server\] LISTEN_URL=/m,
        /^\[BACKEND_PORT\]\d+/m,
      ],
      {
        onReady: assertBackendDbRoute,
      }
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(
    "[runtime-smoke] packaged runtime backend resolved bundled CLIs and served DB route"
  );
}

smokePackagedRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
