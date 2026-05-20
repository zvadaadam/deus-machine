const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../../../..");
const DEFAULT_RUNTIME_TIMEOUT_MS = 45_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const RUNTIME_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "BUN_OPTIONS",
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
const RUNTIME_BINARIES = ["deus-runtime", "codex", "claude", "gh", "rg", "agent-browser"];
const RUNTIME_MANIFESTS = ["deus-runtime.json", "agent-clis.json", "gh-cli.json"];
const OBSOLETE_RUNTIME_PATTERNS = [
  /spawn (codex|claude).*ENOENT/,
  /ELECTRON_RUN_AS_NODE/,
  /resources\/backend/,
  /AGENT_SERVER_ENTRY/,
  /global CLI/,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDirectory(dirPath, label) {
  assert(fs.existsSync(dirPath), `Missing ${label}: ${dirPath}`);
  assert(fs.statSync(dirPath).isDirectory(), `${label} is not a directory: ${dirPath}`);
}

function assertExecutable(filePath, label) {
  assert(fs.existsSync(filePath), `Missing ${label}: ${filePath}`);
  const stat = fs.statSync(filePath);
  assert(stat.isFile(), `${label} is not a regular file: ${filePath}`);
  assert((stat.mode & 0o111) !== 0, `${label} is not executable: ${filePath}`);
}

function assertRegularFile(filePath, label) {
  assert(fs.existsSync(filePath), `Missing ${label}: ${filePath}`);
  assert(fs.statSync(filePath).isFile(), `${label} is not a regular file: ${filePath}`);
}

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

function deterministicRuntimePath(binDir) {
  return [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter);
}

function scrubRuntimeEnv(env) {
  for (const key of RUNTIME_ENV_DENYLIST) {
    delete env[key];
  }
  return env;
}

function runtimeEnv(binDir, extraEnv = {}) {
  const env = scrubRuntimeEnv({ ...process.env });
  if (binDir) {
    env.DEUS_BUNDLED_BIN_DIR = binDir;
    env.PATH = deterministicRuntimePath(binDir);
  }
  return { ...env, ...extraEnv };
}

function packagedDesktopEnv(tempHome) {
  return runtimeEnv(null, {
    HOME: tempHome,
    PATH: PACKAGED_SYSTEM_PATHS.join(path.delimiter),
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathPattern(filePath) {
  const paths = [filePath];
  try {
    paths.push(fs.realpathSync.native(filePath));
  } catch {
    // Keep the original spelling when the path is not present.
  }
  return `(?:${[...new Set(paths)].map(escapeRegExp).join("|")})`;
}

function bundledAgentCliPatterns(binDir) {
  return [
    new RegExp(`BUNDLED_CLI_PATH claude=${escapeRegExp(path.join(binDir, "claude"))}`),
    new RegExp(`BUNDLED_CLI_PATH codex=${escapeRegExp(path.join(binDir, "codex"))}`),
  ];
}

function backendBundledAgentCliPatterns(binDir) {
  return [
    new RegExp(
      `^\\[agent-server\\] BUNDLED_CLI_PATH claude=${escapeRegExp(path.join(binDir, "claude"))}`,
      "m"
    ),
    new RegExp(
      `^\\[agent-server\\] BUNDLED_CLI_PATH codex=${escapeRegExp(path.join(binDir, "codex"))}`,
      "m"
    ),
  ];
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
    `spctl: ${runDiagnostic("spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      runtimeBin,
    ])}`,
    `xattr: ${runDiagnostic("xattr", ["-l", runtimeBin]) || "none"}`,
  ].join("\n");
}

function appDiagnostics(appPath, appBinary) {
  if (process.platform !== "darwin") return "";
  return [
    `file: ${runDiagnostic("file", [appBinary])}`,
    `codesign: ${runDiagnostic("codesign", ["-dv", "--verbose=4", appBinary])}`,
    `spctl: ${runDiagnostic("spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      appPath,
    ])}`,
    `xattr: ${runDiagnostic("xattr", ["-lr", appBinary]) || "none"}`,
  ].join("\n");
}

function macExecutionPolicyHint(diagnostics, kind = "runtime") {
  if (process.platform !== "darwin") return "";
  if (!/spctl:[\s\S]*rejected/.test(diagnostics)) return "";
  if (!/com\.apple\.(provenance|quarantine)/.test(diagnostics)) return "";

  if (kind === "app") {
    return [
      "",
      "macOS rejected this app before packaged Electron reached main-process startup.",
      "This is a host execution-policy failure, not evidence that bundled backend startup failed.",
      "If the app is already installed in /Applications, rerun this smoke with --launch-in-place to avoid copying the Mach-O payload.",
      "Verify packaged desktop readiness on a notarized artifact or a macOS host that allows generated/copied Mach-O app bundles to launch.",
    ].join("\n");
  }

  return [
    "",
    "macOS rejected this executable before user code reached readiness.",
    "If the process times out with no stdout/stderr, verify on a notarized artifact or a macOS host that allows generated Mach-O binaries to launch.",
  ].join("\n");
}

function formatRuntimeFailure(runtimeBin, args, reason, stdout, stderr, diagnostics) {
  const hint = macExecutionPolicyHint(diagnostics);
  return `${path.basename(runtimeBin)} ${args.join(" ")} ${reason} stdout=${stdout
    .trim()
    .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
    diagnostics ? `\n${diagnostics}` : ""
  }${hint}`;
}

async function runRuntimeCommand(runtimeBin, args, binDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
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
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        const diagnostics = runtimeDiagnostics(runtimeBin);
        fail(
          new Error(
            formatRuntimeFailure(
              runtimeBin,
              args,
              `timed out after ${timeoutMs}ms`,
              stdout,
              stderr,
              diagnostics
            )
          )
        );
      }, timeoutMs);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        const diagnostics = runtimeDiagnostics(runtimeBin);
        fail(
          new Error(
            formatRuntimeFailure(
              runtimeBin,
              args,
              `failed to spawn: error=${error.code || error.message}`,
              stdout,
              stderr,
              diagnostics
            )
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
        fail(
          new Error(
            formatRuntimeFailure(
              runtimeBin,
              args,
              `failed: status=${code} signal=${signal ?? "none"}`,
              stdout,
              stderr,
              diagnostics
            )
          )
        );
      });
    });
  } finally {
    await stopChild(child, options.stopTimeoutMs);
  }
}

async function waitForRuntimePatterns(runtimeBin, args, binDir, patterns, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_TIMEOUT_MS;
  const obsoletePatterns = options.obsoletePatterns ?? OBSOLETE_RUNTIME_PATTERNS;
  const obsoleteLabel = options.obsoleteLabel ?? "Runtime smoke";
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
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        settled = true;
        const missing = patterns
          .filter((_, index) => !matched.has(index))
          .map((pattern) => pattern.toString());
        const diagnostics = runtimeDiagnostics(runtimeBin);
        reject(
          new Error(
            formatRuntimeFailure(
              runtimeBin,
              args,
              `did not reach readiness. missing=${missing.join(", ") || "none"}`,
              stdout,
              stderr,
              diagnostics
            )
          )
        );
      }, timeoutMs);
      const inspectOutput = () => {
        if (settled || completing) return;
        const output = `${stdout}\n${stderr}`;
        for (const pattern of obsoletePatterns) {
          if (pattern.test(output)) {
            fail(new Error(`${obsoleteLabel} used obsolete runtime path: ${pattern}`));
            return;
          }
        }
        patterns.forEach((pattern, index) => {
          if (pattern.test(output)) matched.add(index);
        });
        if (matched.size !== patterns.length) return;

        completing = true;
        clearTimeout(timeout);
        Promise.resolve(options.onReady?.(output))
          .then(() => {
            if (settled) return;
            settled = true;
            resolve();
          })
          .catch(fail);
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
        if (settled || matched.size === patterns.length) return;
        const diagnostics = runtimeDiagnostics(runtimeBin);
        fail(
          new Error(
            formatRuntimeFailure(
              runtimeBin,
              args,
              `exited before readiness: code=${code} signal=${signal}`,
              stdout,
              stderr,
              diagnostics
            )
          )
        );
      });
    });
  } finally {
    await stopChild(child, options.stopTimeoutMs);
  }

  return `${stdout}\n${stderr}`;
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

function stopChild(child, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
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

async function assertBackendDbRoute(port, label = "Backend DB route") {
  const response = await getJson(port, "/api/workspaces");
  if (response.statusCode !== 200) {
    throw new Error(
      `${label} failed: GET /api/workspaces returned ${response.statusCode}: ${response.body.slice(
        0,
        500
      )}`
    );
  }

  const parsed = JSON.parse(response.body);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} returned non-array payload: ${response.body.slice(0, 500)}`);
  }
}

async function assertBackendDbRouteFromOutput(output, options = {}) {
  const pattern = options.pattern ?? /^\[BACKEND_PORT\](\d+)/m;
  const match = output.match(pattern);
  if (!match) {
    throw new Error(
      options.missingMessage ?? "Backend DB route check could not find [BACKEND_PORT]"
    );
  }
  await assertBackendDbRoute(Number(match[1]), options.label);
}

function assertRuntimeSelfTest(selfTest, options) {
  const label = options.label;
  if (selfTest.ok !== true) {
    throw new Error(`${label} self-test failed: ${JSON.stringify(selfTest)}`);
  }
  if (selfTest.nodeEnv !== "production") {
    throw new Error(
      `${label} self-test expected NODE_ENV=production: ${selfTest.nodeEnv}; selfTest=${JSON.stringify(
        selfTest
      )}`
    );
  }
  if (path.resolve(String(selfTest.binDir || "")) !== path.resolve(options.binDir)) {
    throw new Error(
      `${label} self-test resolved unexpected binDir: ${selfTest.binDir}; expected ${options.binDir}`
    );
  }
  const expectedPath = options.pathEnv ?? deterministicRuntimePath(options.binDir);
  if (selfTest.pathEnv !== expectedPath) {
    throw new Error(
      `${label} self-test expected deterministic PATH ${expectedPath}: ${selfTest.pathEnv}`
    );
  }
  if (path.resolve(String(selfTest.resourcesPath || "")) !== path.resolve(options.resourcesPath)) {
    throw new Error(
      `${label} self-test resolved unexpected resourcesPath: ${selfTest.resourcesPath}; expected ${options.resourcesPath}`
    );
  }

  const nodePathEntries = String(selfTest.nodePath || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  for (const expectedNodePath of options.expectedNodePaths) {
    if (!nodePathEntries.includes(path.resolve(expectedNodePath))) {
      throw new Error(
        `${label} self-test NODE_PATH is missing ${expectedNodePath}: ${selfTest.nodePath}`
      );
    }
  }
}

function assertHostRunnableArch(filePath, label) {
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
      `${label} architecture does not match this host; expected ${expectedArch}: ${output}`
    );
  }
}

function verifyGatekeeperAssessment(appPath) {
  execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

module.exports = {
  DEFAULT_RUNTIME_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  OBSOLETE_RUNTIME_PATTERNS,
  PACKAGED_SYSTEM_PATHS,
  PROJECT_ROOT,
  RUNTIME_BINARIES,
  RUNTIME_ENV_DENYLIST,
  RUNTIME_MANIFESTS,
  appDiagnostics,
  assert,
  assertBackendDbRoute,
  assertBackendDbRouteFromOutput,
  assertDirectory,
  assertExecutable,
  assertHostRunnableArch,
  assertRegularFile,
  assertRuntimeSelfTest,
  backendBundledAgentCliPatterns,
  bundledAgentCliPatterns,
  deterministicRuntimePath,
  escapeRegExp,
  getJson,
  macExecutionPolicyHint,
  packagedDesktopEnv,
  pathPattern,
  resolveDefaultAppPath,
  runDiagnostic,
  runRuntimeCommand,
  runtimeDiagnostics,
  runtimeEnv,
  scrubRuntimeEnv,
  stopChild,
  verifyGatekeeperAssessment,
  waitForRuntimePatterns,
};
