const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { assertInitializedAgents, readAgentServerListenUrl } = require("./runtime-rpc.cjs");
const {
  PROJECT_ROOT,
  assertBackendDbRouteFromOutput,
  assertExecutable,
  assertRuntimeSelfTest,
  backendBundledAgentCliPatterns,
  bundledAgentCliPatterns,
  runRuntimeCommand,
  waitForRuntimePatterns,
} = require("./lib/smoke-helpers.cjs");

function defaultRuntimeKey() {
  if (process.platform !== "darwin") return null;
  if (process.arch === "arm64" || process.arch === "x64") return `darwin-${process.arch}`;
  return null;
}

function parseArgs(argv) {
  const options = {
    runtimeKey: defaultRuntimeKey(),
    skipValidate: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--runtime-key") {
      options.runtimeKey = argv[++index];
    } else if (arg === "--skip-validate") {
      options.skipValidate = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.runtimeKey) {
    throw new Error(`No staged native runtime key for ${process.platform}-${process.arch}`);
  }
  if (!/^darwin-(arm64|x64)$/.test(options.runtimeKey)) {
    throw new Error(`Unsupported native runtime key: ${options.runtimeKey}`);
  }
  return options;
}

function printUsage() {
  console.log(`Usage: bun run smoke:runtime-native -- [options]

Options:
  --runtime-key <key>      Staged runtime key, defaults to host key
  --skip-validate          Skip bun run validate:runtime before executing

Runs direct smokes against dist/runtime/electron/bin/<runtime-key>/deus-runtime:
--version, self-test, agent-server readiness, and backend readiness.`);
}

function runValidateRuntime() {
  execFileSync("bun", ["run", "validate:runtime"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

async function assertInitializedAgentsFromOutput(output, message) {
  const listenUrl = readAgentServerListenUrl(output);
  if (!listenUrl) throw new Error(message);
  await assertInitializedAgents(listenUrl);
}

async function smokeAgentServer(runtimeBin, binDir) {
  await waitForRuntimePatterns(
    runtimeBin,
    ["agent-server"],
    binDir,
    [...bundledAgentCliPatterns(binDir), /LISTEN_URL=/],
    {
      obsoleteLabel: "Native runtime smoke",
      onReady: (output) =>
        assertInitializedAgentsFromOutput(
          output,
          "Native runtime output did not include LISTEN_URL"
        ),
    }
  );
  console.log(
    "[runtime-smoke] native runtime agent-server resolved bundled CLIs and initialized agents"
  );
}

async function smokeBackend(runtimeBin, binDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-native-runtime-"));
  try {
    await waitForRuntimePatterns(
      runtimeBin,
      ["backend", "--data-dir", dataDir],
      binDir,
      [
        ...backendBundledAgentCliPatterns(binDir),
        /^\[agent-server\] LISTEN_URL=/m,
        /^\[BACKEND_PORT\]\d+/m,
      ],
      {
        obsoleteLabel: "Native runtime smoke",
        onReady: async (output) => {
          await assertBackendDbRouteFromOutput(output);
          await assertInitializedAgentsFromOutput(
            output,
            "Native backend runtime output did not include agent-server LISTEN_URL"
          );
        },
      }
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(
    "[runtime-smoke] native runtime backend resolved bundled CLIs, initialized agents, and served DB route"
  );
}

async function smokeNativeRuntime(options) {
  if (!options.skipValidate) runValidateRuntime();

  const resourcesDir = path.join(PROJECT_ROOT, "dist", "runtime", "electron");
  const binDir = path.join(resourcesDir, "bin", options.runtimeKey);
  const runtimeBin = path.join(binDir, "deus-runtime");
  assertExecutable(runtimeBin, `staged ${options.runtimeKey} Deus runtime`);

  const version = await runRuntimeCommand(runtimeBin, ["--version"], binDir);
  if (!new RegExp(`^deus-runtime \\d+\\.\\d+\\.\\d+ ${options.runtimeKey}$`).test(version)) {
    throw new Error(`Unexpected staged runtime version output: ${version}`);
  }
  console.log(`[runtime-smoke] native runtime version: ${version}`);

  const selfTest = JSON.parse(await runRuntimeCommand(runtimeBin, ["self-test"], binDir));
  assertRuntimeSelfTest(selfTest, {
    label: "Native runtime",
    binDir,
    resourcesPath: resourcesDir,
    expectedNodePaths: [
      path.join(resourcesDir, "app.asar.unpacked", "node_modules"),
      path.join(PROJECT_ROOT, "node_modules"),
    ],
  });
  console.log(`[runtime-smoke] native runtime self-test binDir: ${selfTest.binDir}`);

  await smokeAgentServer(runtimeBin, binDir);
  await smokeBackend(runtimeBin, binDir);
}

smokeNativeRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
