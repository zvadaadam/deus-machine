const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_APP_PATH = path.join(PROJECT_ROOT, "dist-electron", "mac-arm64", "Deus.app");
const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const PACKAGED_RUNTIME_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "ELECTRON_RUN_AS_NODE",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "NODE_PATH",
];
const REQUIRED_LOG_PATTERNS = [
  /\[main\] App ready, starting initialization/,
  /\[main\] Spawning runtime stack/,
  /\[backend\] \[agent-server\] BUNDLED_CLI_PATH claude=.*\/claude/,
  /\[backend\] \[agent-server\] BUNDLED_CLI_PATH codex=.*\/codex/,
  /\[backend\] \[agent-server\] LISTEN_URL=/,
  /\[backend\] \[BACKEND_PORT\]\d+/,
  /\[main\] Backend started on port: \d+/,
  /\[main\] Window created/,
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
  console.log(`Usage: node scripts/runtime/smoke-packaged-desktop.cjs [app-path]

Options:
  --app <path>             Path to the packaged .app bundle
  --require-gatekeeper     Require spctl execute assessment in the app check
  --skip-app-check         Skip smoke-packaged-app.cjs

This smoke launches the packaged Electron app with an isolated temporary HOME.
It copies Deus.app to that HOME's Applications directory so the packaged
Applications-folder preflight does not block backend startup.`);
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

async function waitForDesktopReadiness(child, tempHome) {
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

      REQUIRED_LOG_PATTERNS.forEach((pattern, index) => {
        if (pattern.test(contents)) matched.add(index);
      });
      if (matched.size === REQUIRED_LOG_PATTERNS.length) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 500);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(
        new Error(
          `Packaged desktop did not reach readiness. logPath=${lastLogPath ?? "missing"} log=${lastLog.slice(
            -4000
          )}`
        )
      );
    }, STARTUP_TIMEOUT_MS);

    child.on("exit", (code, signal) => {
      if (matched.size !== REQUIRED_LOG_PATTERNS.length) {
        clearInterval(interval);
        clearTimeout(timeout);
        reject(
          new Error(
            `Packaged desktop exited before readiness: code=${code} signal=${signal} logPath=${
              lastLogPath ?? "missing"
            } log=${lastLog.slice(-4000)}`
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

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deus-packaged-desktop-"));
  const tempHome = path.join(tempRoot, "home");
  fs.mkdirSync(tempHome, { recursive: true });
  const launchAppPath = copyAppToTempApplications(options.appPath, tempHome);
  const appBinary = path.join(launchAppPath, "Contents", "MacOS", "Deus");
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
    const { logPath } = await waitForDesktopReadiness(child, tempHome);
    console.log(`[runtime-smoke] packaged desktop reached readiness; log=${logPath}`);
  } catch (error) {
    if (stderr.trim()) {
      console.error(`[runtime-smoke] packaged desktop stderr:\n${stderr.trim()}`);
    }
    throw error;
  } finally {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

smokePackagedDesktop(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
