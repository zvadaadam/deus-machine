const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const WebSocket = require("ws");
const { ENGINE_STARTED, assertEngineStarted } = require("./engine-ready.cjs");
const {
  PROJECT_ROOT,
  assertBackendDbRouteFromOutput,
  assertExecutable,
  assertHostRunnableArch,
  assertRuntimeSelfTest,
  bundledAgentCliPatterns,
  resolveDefaultAppPath,
  runRuntimeCommand,
  waitForRuntimePatterns,
} = require("./lib/smoke-helpers.cjs");

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

  options.appPath = path.resolve(options.appPath ?? resolveDefaultAppPath());
  return options;
}

function printUsage() {
  console.log(`Usage: bun run smoke:packaged-runtime -- [app-path]

Options:
  --app <path>             Path to the packaged .app bundle
  --require-gatekeeper     Require spctl execute assessment in the app check
  --skip-app-check         Skip the packaged app smoke and only run runtime commands

This smoke executes the packaged Resources/bin/deus-runtime. It should be run
on notarized release artifacts or hosts that allow generated/copied Mach-O
binaries to launch directly.`);
}

function runAppCheck(appPath, options) {
  if (options.skipAppCheck) return;

  const args = [
    path.join(PROJECT_ROOT, "scripts", "runtime", "smoke", "packaged-app.cjs"),
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

function sendWsRequest(port, resource, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = `${resource}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let settled = false;
    let sent = false;

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        // Best-effort cleanup.
      }
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const timeout = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for q:response ${resource}`));
    }, timeoutMs);
    const send = () => {
      if (sent) return;
      sent = true;
      ws.send(JSON.stringify({ type: "q:request", id, resource, params }));
    };

    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === "connected") {
        send();
        return;
      }
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.id !== id) return;
      if (message.type === "q:response") {
        finish(resolve, message.data);
      } else if (message.type === "q:error") {
        finish(reject, new Error(`q:request ${resource} rejected: ${message.message}`));
      }
    });
    ws.on("open", () => {
      // Localhost backends immediately send a connected frame, which triggers
      // the request. Keep this handler only so websocket errors before open are
      // clearly separated from a missing connected frame timeout.
    });
    ws.on("error", (error) => finish(reject, error));
    ws.on("close", (code, reason) => {
      if (!settled) {
        finish(
          reject,
          new Error(`WebSocket closed before q:response ${resource}: ${code} ${reason}`)
        );
      }
    });
  });
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

  const answer = await sendWsRequest(port, "sim:listDevices", {}, 45_000);
  if (!Array.isArray(answer?.devices)) {
    throw new Error(`sim:listDevices returned unexpected payload: ${JSON.stringify(answer)}`);
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
          await assertBackendDbRouteFromOutput(output);
          assertEngineStarted(output);
          await smokeBackendCommands(port);
        },
      }
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(
    "[runtime-smoke] packaged runtime backend resolved bundled CLIs, started the agent engine, and served DB route"
  );
}

async function smokePackagedRuntime(options) {
  const appPath = options.appPath;
  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const binDir = path.join(resourcesDir, "bin");
  const runtimeBin = path.join(binDir, "deus-runtime");
  assertExecutable(runtimeBin, "packaged Deus runtime");
  assertHostRunnableArch(runtimeBin, "Packaged runtime");

  runAppCheck(appPath, options);

  const version = await runRuntimeCommand(runtimeBin, ["--version"], binDir);
  if (!/^deus-runtime \d+\.\d+\.\d+ /.test(version)) {
    throw new Error(`Unexpected packaged runtime version output: ${version}`);
  }
  console.log(`[runtime-smoke] packaged runtime version: ${version}`);

  const selfTest = JSON.parse(await runRuntimeCommand(runtimeBin, ["self-test"], binDir));
  assertRuntimeSelfTest(selfTest, {
    label: "Packaged runtime",
    binDir,
    resourcesPath: resourcesDir,
    expectedNodePaths: [path.join(resourcesDir, "app.asar.unpacked", "node_modules")],
  });
  console.log(`[runtime-smoke] packaged runtime self-test binDir: ${selfTest.binDir}`);

  await smokeBackend(runtimeBin, binDir);
}

smokePackagedRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
