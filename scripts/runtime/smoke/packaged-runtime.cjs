const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BUNDLED_BINARIES } = require("../electron-builder-after-pack.cjs");
const { ENGINE_STARTED, assertEngineStarted } = require("./engine-ready.cjs");
const {
  PROJECT_ROOT,
  assertBackendReadsDatabaseFromOutput,
  assertExecutable,
  assertHostRunnableArch,
  assertRuntimeSelfTest,
  bundledAgentCliPatterns,
  readFromBackend,
  resolveDefaultAppPath,
  runRuntimeCommand,
  waitForRuntimePatterns,
} = require("./lib/smoke-helpers.cjs");

function parseArgs(argv) {
  const options = { appPath: null };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--app") {
      options.appPath = argv[++index];
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

  options.appPath = path.resolve(options.appPath ?? resolveDefaultAppPath());
  return options;
}

function printUsage() {
  console.log(`Usage: bun run smoke:packaged-runtime -- [app-path]

Options:
  --app <path>             The packaged .app bundle, or a Linux package's resources folder

Runs every bundled executable's --version, then the packaged deus-runtime's
self-test and backend.`);
}

function readBackendPort(output) {
  const match = output.match(/^\[BACKEND_PORT\](\d+)/m);
  if (!match) throw new Error("Packaged backend runtime output did not include [BACKEND_PORT]");
  return Number(match[1]);
}

function isCliAvailable(command) {
  const result = spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)}`], {
    stdio: "ignore",
    timeout: 2_000,
  });
  return result.status === 0;
}

async function smokeBackendCommands(port) {
  if (process.platform !== "darwin") {
    console.log("[runtime-smoke] packaged backend simulator command smoke skipped off macOS");
    return;
  }
  if (!isCliAvailable("xcrun")) {
    console.log(
      "[runtime-smoke] packaged backend simulator command smoke skipped: xcrun unavailable"
    );
    return;
  }

  const answer = await readFromBackend(port, "simListDevices", {}, 45_000);
  if (!Array.isArray(answer?.devices)) {
    throw new Error(`simListDevices returned unexpected payload: ${JSON.stringify(answer)}`);
  }
  console.log(
    `[runtime-smoke] packaged backend simulator q:request listed ${answer.devices.length} devices`
  );
}

async function smokeBackend(runtimeBin, binDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-packaged-runtime-"));
  try {
    await waitForRuntimePatterns(
      runtimeBin,
      ["backend", "--data-dir", dataDir],
      binDir,
      [...bundledAgentCliPatterns(binDir), ENGINE_STARTED, /^\[BACKEND_PORT\]\d+/m],
      {
        obsoleteLabel: "Packaged runtime smoke",
        onReady: async (output) => {
          const port = readBackendPort(output);
          await assertBackendReadsDatabaseFromOutput(output);
          assertEngineStarted(output);
          await smokeBackendCommands(port);
        },
      }
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(
    "[runtime-smoke] packaged runtime backend resolved bundled CLIs, started the agent engine, and read its database"
  );
}

async function smokePackagedRuntime(options) {
  const appPath = options.appPath;
  const resourcesDir = appPath.endsWith(".app")
    ? path.join(appPath, "Contents", "Resources")
    : appPath;
  const binDir = path.join(resourcesDir, "bin");
  const runtimeBin = path.join(binDir, "deus-runtime");
  assertExecutable(runtimeBin, "packaged Deus runtime");
  assertHostRunnableArch(runtimeBin, "Packaged runtime");

  const { version } = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  for (const name of BUNDLED_BINARIES) {
    const output = await runRuntimeCommand(path.join(binDir, name), ["--version"], binDir);
    if (name === "deus-runtime" && !output.startsWith(`deus-runtime ${version} `)) {
      throw new Error(`Packaged runtime is not version ${version}: ${output}`);
    }
    console.log(`[runtime-smoke] packaged ${name} --version: ${output.split("\n")[0]}`);
  }

  const selfTest = JSON.parse(await runRuntimeCommand(runtimeBin, ["self-test"], binDir));
  assertRuntimeSelfTest(selfTest, {
    label: "Packaged runtime",
    binDir,
    resourcesPath: resourcesDir,
  });
  console.log(`[runtime-smoke] packaged runtime self-test binDir: ${selfTest.binDir}`);

  await smokeBackend(runtimeBin, binDir);
}

smokePackagedRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
