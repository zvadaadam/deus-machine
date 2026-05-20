const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { assertInitializedAgents, readAgentServerListenUrl } = require("./runtime-rpc.cjs");
const {
  PROJECT_ROOT,
  appDiagnostics,
  assert,
  assertBackendDbRoute,
  assertExecutable,
  assertHostRunnableArch,
  macExecutionPolicyHint,
  packagedDesktopEnv,
  pathPattern,
  resolveDefaultAppPath,
  stopChild,
  verifyGatekeeperAssessment,
} = require("./lib/smoke-helpers.cjs");

const DEFAULT_APP_PATH = resolveDefaultAppPath();
const STARTUP_TIMEOUT_MS = 60_000;
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
  console.log(`Usage: bun run smoke:packaged-desktop -- [app-path]

Options:
  --app <path>             Path to the packaged .app bundle
  --home <path>            HOME to use while launching the packaged app
  --launch-in-place        Launch --app directly instead of copying it to a temp Applications dir
  --require-gatekeeper     Require spctl execute assessment in the app check
  --skip-app-check         Skip the packaged app smoke

This smoke launches the packaged Electron app with an isolated temporary HOME.
It copies Deus.app to that HOME's Applications directory so the packaged
Applications-folder preflight does not block backend startup.

Use --launch-in-place for already-installed/notarized app bundles when copying
the Mach-O payload would invalidate the host's launch-policy decision.`);
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

function requiredLogPatterns(binDir) {
  return [
    /\[main\] App ready, starting initialization/,
    /\[main\] Spawning runtime stack/,
    new RegExp(
      `\\[backend\\] \\[agent-server\\] BUNDLED_CLI_PATH claude=${pathPattern(
        path.join(binDir, "claude")
      )}`
    ),
    new RegExp(
      `\\[backend\\] \\[agent-server\\] BUNDLED_CLI_PATH codex=${pathPattern(
        path.join(binDir, "codex")
      )}`
    ),
    /\[backend\] \[agent-server\] LISTEN_URL=/,
    /\[backend\] \[BACKEND_PORT\]\d+/,
    /\[main\] Backend started on port: \d+/,
    /\[main\] Window created/,
  ];
}

async function assertBackendDbRouteFromLog(logContents) {
  const match = logContents.match(/\[backend\] \[BACKEND_PORT\](\d+)/);
  if (!match) throw new Error("Packaged desktop log did not include [BACKEND_PORT]");
  await assertBackendDbRoute(Number(match[1]), "Packaged desktop backend DB route");
}

async function assertInitializedAgentsFromLog(logContents) {
  const listenUrl = readAgentServerListenUrl(logContents);
  if (!listenUrl) throw new Error("Packaged desktop log did not include agent-server LISTEN_URL");
  await assertInitializedAgents(listenUrl);
}

function runAppCheck(appPath, options) {
  if (options.skipAppCheck) return;

  const args = [
    path.join(PROJECT_ROOT, "scripts", "runtime", "smoke", "packaged-app.cjs"),
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

async function waitForDesktopReadiness(
  child,
  tempHome,
  requiredPatterns,
  diagnostics,
  getProcessOutput
) {
  const matched = new Set();
  let lastLog = "";
  let lastLogPath = null;

  await new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const { logPath, contents } = readMainLog(tempHome);
      lastLogPath = logPath;
      lastLog = [contents, getProcessOutput()].filter(Boolean).join("\n");

      for (const pattern of FORBIDDEN_LOG_PATTERNS) {
        if (pattern.test(lastLog)) {
          clearInterval(interval);
          clearTimeout(timeout);
          reject(new Error(`Packaged desktop smoke hit forbidden log pattern: ${pattern}`));
          return;
        }
      }

      requiredPatterns.forEach((pattern, index) => {
        if (pattern.test(lastLog)) matched.add(index);
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
            diagnostics,
            "app"
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
              diagnostics,
              "app"
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

  const { logPath, contents } = readMainLog(tempHome);
  return {
    logPath,
    contents: [contents, getProcessOutput()].filter(Boolean).join("\n"),
  };
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
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr?.on("data", (data) => {
    stderr += data.toString();
  });
  const getProcessOutput = () => [stdout, stderr].filter(Boolean).join("\n");

  try {
    const { logPath, contents } = await waitForDesktopReadiness(
      child,
      tempHome,
      requiredLogPatterns(binDir),
      appDiagnostics(launchAppPath, appBinary),
      getProcessOutput
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
