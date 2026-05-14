const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { assertInitializedAgents, readAgentServerListenUrl } = require("./runtime-smoke-rpc.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_APP_PATH = path.join(PROJECT_ROOT, "dist-electron", "mac-arm64", "Deus.app");
const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const PACKAGED_RUNTIME_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_BACKEND_PORT",
  "DEUS_DATA_DIR",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "NODE_PATH",
  "PORT",
];
const FORBIDDEN_LOG_PATTERNS = [
  /spawn (codex|claude).*ENOENT/,
  /ELECTRON_RUN_AS_NODE/,
  /resources\/backend/,
  /AGENT_SERVER_ENTRY/,
  /global CLI/,
  /Backend spawn FAILED/,
];

function parseArgs(argv) {
  const options = {
    appPath: null,
    homePath: null,
    launchInPlace: false,
    requireGatekeeper: false,
    skipAppCheck: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--app") {
      const value = argv[++index];
      if (!value) throw new Error("--app requires a path");
      options.appPath = value;
    } else if (arg === "--home") {
      const value = argv[++index];
      if (!value) throw new Error("--home requires a path");
      options.homePath = path.resolve(value);
    } else if (arg === "--launch-in-place") {
      options.launchInPlace = true;
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
  console.log(`Usage: node scripts/runtime/smoke-packaged-desktop.cjs [app-path]

Options:
  --app <path>             Path to the packaged .app bundle
  --home <path>            HOME to use while launching the packaged app
  --launch-in-place        Launch --app directly instead of copying it to a temp Applications dir
  --require-gatekeeper     Require spctl execute assessment in the app check
  --skip-app-check         Skip smoke-packaged-app.cjs

This smoke launches the packaged Electron app with an isolated temporary HOME.
It copies Deus.app to that HOME's Applications directory so the packaged
Applications-folder preflight does not block backend startup.

Use --launch-in-place for already-installed/notarized app bundles when copying
the Mach-O payload would invalidate the host's launch-policy decision.`);
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

function isInsideDirectory(filePath, directoryPath) {
  const normalizedDirectory = `${path.resolve(directoryPath)}${path.sep}`;
  const normalizedFile = path.resolve(filePath);
  return normalizedFile.startsWith(normalizedDirectory);
}

function isApplicationsInstallPath(appPath, homePath) {
  return (
    isInsideDirectory(appPath, "/Applications") ||
    isInsideDirectory(appPath, path.join(homePath, "Applications"))
  );
}

function assertLaunchInPlaceInstallPath(appPath, homePath) {
  if (isApplicationsInstallPath(appPath, homePath)) return;
  throw new Error(
    `--launch-in-place requires --app to be inside /Applications or --home/Applications so the packaged install preflight does not block startup: app=${appPath} home=${homePath}`
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requiredLogPatterns(binDir) {
  return [
    /\[main\] App ready, starting initialization/,
    /\[main\] Spawning runtime stack/,
    new RegExp(
      `\\[backend\\] \\[agent-server\\] BUNDLED_CLI_PATH claude=${escapeRegExp(
        path.join(binDir, "claude")
      )}`
    ),
    new RegExp(
      `\\[backend\\] \\[agent-server\\] BUNDLED_CLI_PATH codex=${escapeRegExp(
        path.join(binDir, "codex")
      )}`
    ),
    /\[backend\] \[agent-server\] LISTEN_URL=/,
    /\[backend\] \[BACKEND_PORT\]\d+/,
    /\[main\] Backend started on port: \d+/,
    /\[main\] Window created/,
  ];
}

function assertHostRunnableArch(filePath, label) {
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
      `Packaged ${label} architecture does not match this host; expected ${expectedArch}: ${output}`
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

function appDiagnostics(appPath, appBinary) {
  if (process.platform !== "darwin") return "";
  return [
    `file: ${runDiagnostic("file", [appBinary])}`,
    `codesign: ${runDiagnostic("codesign", ["-dv", "--verbose=4", appBinary])}`,
    `spctl: ${runDiagnostic("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath])}`,
    `xattr: ${runDiagnostic("xattr", ["-lr", appBinary]) || "none"}`,
  ].join("\n");
}

function macExecutionPolicyHint(diagnostics) {
  if (process.platform !== "darwin") return "";
  if (!/spctl:[\s\S]*rejected/.test(diagnostics)) return "";
  if (!/com\.apple\.(provenance|quarantine)/.test(diagnostics)) return "";

  return [
    "",
    "macOS rejected this app before packaged Electron reached main-process startup.",
    "This is a host execution-policy failure, not evidence that bundled backend startup failed.",
    "If the app is already installed in /Applications, rerun this smoke with --launch-in-place to avoid copying the Mach-O payload.",
    "Verify packaged desktop readiness on a notarized artifact or a macOS host that allows generated/copied Mach-O app bundles to launch.",
  ].join("\n");
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

async function assertBackendDbRouteFromLog(logContents) {
  const match = logContents.match(/\[backend\] \[BACKEND_PORT\](\d+)/);
  if (!match) throw new Error("Packaged desktop log did not include [BACKEND_PORT]");

  const response = await getJson(Number(match[1]), "/api/workspaces");
  if (response.statusCode !== 200) {
    throw new Error(
      `Packaged desktop backend DB route failed: GET /api/workspaces returned ${
        response.statusCode
      }: ${response.body.slice(0, 500)}`
    );
  }

  const parsed = JSON.parse(response.body);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Packaged desktop backend DB route returned non-array payload: ${response.body.slice(0, 500)}`
    );
  }
}

async function assertInitializedAgentsFromLog(logContents) {
  const listenUrl = readAgentServerListenUrl(logContents);
  if (!listenUrl) throw new Error("Packaged desktop log did not include agent-server LISTEN_URL");
  await assertInitializedAgents(listenUrl);
}

function packagedDesktopEnv(tempHome) {
  const env = {
    ...process.env,
    HOME: tempHome,
    PATH: PACKAGED_SYSTEM_PATHS.join(path.delimiter),
  };
  for (const key of PACKAGED_RUNTIME_ENV_DENYLIST) {
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
  ];
  if (options.requireGatekeeper) args.push("--require-gatekeeper");

  execFileSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

function copyAppToTempApplications(sourceAppPath, tempHome) {
  const applicationsDir = path.join(tempHome, "Applications");
  const targetAppPath = path.join(applicationsDir, "Deus.app");
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.rmSync(targetAppPath, { recursive: true, force: true });
  execFileSync("ditto", [sourceAppPath, targetAppPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return targetAppPath;
}

function findMainLogPath(tempHome) {
  const candidates = [];

  function visit(dir, depth) {
    if (depth > 5 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(entryPath, depth + 1);
      else if (entry.isFile() && entry.name === "main.log") candidates.push(entryPath);
    }
  }

  visit(path.join(tempHome, "Library"), 0);
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function readMainLog(tempHome) {
  const logPath = findMainLogPath(tempHome);
  if (!logPath) return { logPath: null, contents: "" };
  return { logPath, contents: fs.readFileSync(logPath, "utf8") };
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

async function waitForDesktopReadiness(child, tempHome, requiredPatterns, diagnostics) {
  const matched = new Set();
  let lastLog = "";
  let lastLogPath = null;

  await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const { logPath, contents } = readMainLog(tempHome);
      lastLogPath = logPath;
      lastLog = contents;

      for (const pattern of FORBIDDEN_LOG_PATTERNS) {
        if (pattern.test(contents)) {
          clearInterval(interval);
          clearTimeout(timeout);
          reject(new Error(`Packaged desktop smoke hit forbidden log pattern: ${pattern}`));
          return;
        }
      }

      requiredPatterns.forEach((pattern, index) => {
        if (pattern.test(contents)) matched.add(index);
      });
      if (matched.size === requiredPatterns.length) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 500);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      const missing = requiredPatterns
        .filter((_, index) => !matched.has(index))
        .map((pattern) => pattern.toString());
      reject(
        new Error(
          `Packaged desktop did not reach readiness. missing=${missing.join(", ") || "none"} logPath=${
            lastLogPath ?? "missing"
          } log=${lastLog.slice(-4000)}${diagnostics ? `\n${diagnostics}` : ""}${macExecutionPolicyHint(
            diagnostics
          )}`
        )
      );
    }, STARTUP_TIMEOUT_MS);

    child.on("exit", (code, signal) => {
      if (matched.size !== requiredPatterns.length) {
        clearInterval(interval);
        clearTimeout(timeout);
        reject(
          new Error(
            `Packaged desktop exited before readiness: code=${code} signal=${signal} logPath=${
              lastLogPath ?? "missing"
            } log=${lastLog.slice(-4000)}${diagnostics ? `\n${diagnostics}` : ""}${macExecutionPolicyHint(
              diagnostics
            )}`
          )
        );
      }
    });
    child.on("error", (error) => {
      clearInterval(interval);
      clearTimeout(timeout);
      reject(error);
    });
  });

  return readMainLog(tempHome);
}

async function smokePackagedDesktop(options) {
  assert(fs.existsSync(options.appPath), `Missing packaged app: ${options.appPath}`);
  runAppCheck(options.appPath, options);

  const tempRoot = options.homePath
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "deus-packaged-desktop-"));
  const tempHome = options.homePath ?? path.join(tempRoot, "home");
  fs.mkdirSync(tempHome, { recursive: true });
  const launchAppPath = options.launchInPlace
    ? options.appPath
    : copyAppToTempApplications(options.appPath, tempHome);
  if (options.launchInPlace) {
    assertLaunchInPlaceInstallPath(launchAppPath, tempHome);
  }
  const appBinary = path.join(launchAppPath, "Contents", "MacOS", "Deus");
  const binDir = path.join(launchAppPath, "Contents", "Resources", "bin");
  assertExecutable(appBinary, "packaged Deus app executable");
  assertHostRunnableArch(appBinary, "Deus app executable");
  if (options.requireGatekeeper) {
    verifyGatekeeperAssessment(launchAppPath);
  }

  const child = spawn(appBinary, [], {
    cwd: tempHome,
    detached: process.platform !== "win32",
    env: packagedDesktopEnv(tempHome),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data.toString();
  });

  try {
    const { logPath, contents } = await waitForDesktopReadiness(
      child,
      tempHome,
      requiredLogPatterns(binDir),
      appDiagnostics(launchAppPath, appBinary)
    );
    await assertInitializedAgentsFromLog(contents);
    await assertBackendDbRouteFromLog(contents);
    console.log(
      `[runtime-smoke] packaged desktop reached readiness, initialized agents, and served DB route; log=${logPath}`
    );
  } catch (error) {
    if (stderr.trim()) {
      console.error(`[runtime-smoke] packaged desktop stderr:\n${stderr.trim()}`);
    }
    throw error;
  } finally {
    await stopChild(child);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

smokePackagedDesktop(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
