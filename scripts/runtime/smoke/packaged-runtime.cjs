const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:net");
const WebSocket = require("ws");
const { assertInitializedAgents, readAgentServerListenUrl } = require("./runtime-rpc.cjs");
const {
  PROJECT_ROOT,
  PACKAGED_SYSTEM_PATHS,
  assertBackendDbRouteFromOutput,
  assertExecutable,
  assertHostRunnableArch,
  assertRuntimeSelfTest,
  backendBundledAgentCliPatterns,
  bundledAgentCliPatterns,
  getJson,
  resolveDefaultAppPath,
  runtimeEnv,
  stopChild,
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

async function assertInitializedAgentsFromOutput(output, message) {
  const listenUrl = readAgentServerListenUrl(output);
  if (!listenUrl) throw new Error(message);
  await assertInitializedAgents(listenUrl);
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

function sendWsCommand(port, command, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = `${command}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      finish(reject, new Error(`Timed out waiting for q:command_ack ${command}`));
    }, timeoutMs);
    const send = () => {
      if (sent) return;
      sent = true;
      ws.send(JSON.stringify({ type: "q:command", id, command, params }));
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
      if (message.type !== "q:command_ack" || message.id !== id) return;
      if (message.accepted) {
        finish(resolve, message);
      } else {
        finish(reject, new Error(`q:command ${command} rejected: ${message.error}`));
      }
    });
    ws.on("open", () => {
      // Localhost backends immediately send a connected frame, which triggers
      // the command. Keep this handler only so websocket errors before open are
      // clearly separated from a missing connected frame timeout.
    });
    ws.on("error", (error) => finish(reject, error));
    ws.on("close", (code, reason) => {
      if (!settled) {
        finish(
          reject,
          new Error(`WebSocket closed before q:command_ack ${command}: ${code} ${reason}`)
        );
      }
    });
  });
}

function requestJson(port, method, route, body, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `${method} ${route} failed with ${statusCode}: ${responseBody.slice(0, 1000)}`
              )
            );
            return;
          }
          try {
            resolve(responseBody ? JSON.parse(responseBody) : null);
          } catch (error) {
            reject(new Error(`${method} ${route} returned invalid JSON: ${error.message}`));
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out waiting for ${method} ${route}`));
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function createSmokeGitRepo(dataDir) {
  const repoRoot = path.join(dataDir, "aap-repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Packaged runtime smoke\n");
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Deus Runtime Smoke",
      "-c",
      "user.email=runtime-smoke@deus.local",
      "commit",
      "-m",
      "Initial smoke repo",
    ],
    { cwd: repoRoot, stdio: "ignore" }
  );
  return repoRoot;
}

async function waitForWorkspaceReady(port, workspaceId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workspace = await requestJson(
      port,
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}`
    );
    if (workspace?.state === "ready") return workspace;
    if (workspace?.state === "error") {
      throw new Error(`Smoke workspace initialization failed: ${JSON.stringify(workspace)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for smoke workspace ${workspaceId} to become ready`);
}

async function createAapWorkspace(port, dataDir) {
  // Keep DB writes inside the packaged backend process. Loading host
  // better-sqlite3 here makes the smoke depend on Node/Electron rebuild order.
  const repoRoot = createSmokeGitRepo(dataDir);
  const repo = await requestJson(port, "POST", "/api/repos", { root_path: repoRoot });
  if (!repo?.id) {
    throw new Error(`POST /api/repos returned unexpected payload: ${JSON.stringify(repo)}`);
  }

  const workspace = await requestJson(port, "POST", "/api/workspaces", {
    repository_id: repo.id,
    pr_title: "Mobile Use smoke",
  });
  if (!workspace?.id) {
    throw new Error(
      `POST /api/workspaces returned unexpected payload: ${JSON.stringify(workspace)}`
    );
  }
  const readyWorkspace = await waitForWorkspaceReady(port, workspace.id);

  return { workspaceId: readyWorkspace.id };
}

async function smokeBackendCommands(port, dataDir) {
  if (process.platform !== "darwin") {
    console.log("[runtime-smoke] packaged backend simulator/AAP command smoke skipped off macOS");
    return;
  }
  if (!isCliAvailable("xcrun")) {
    console.log("[runtime-smoke] packaged backend simulator/AAP command smoke skipped: xcrun unavailable");
    return;
  }

  const devicesAck = await sendWsCommand(port, "sim:listDevices", {}, 30_000);
  if (!Array.isArray(devicesAck.devices)) {
    throw new Error(`sim:listDevices returned unexpected payload: ${JSON.stringify(devicesAck)}`);
  }
  console.log(
    `[runtime-smoke] packaged backend simulator q:command listed ${devicesAck.devices.length} devices`
  );

  const { workspaceId } = await createAapWorkspace(port, dataDir);
  let runningAppId = null;
  try {
    const launchAck = await sendWsCommand(
      port,
      "launchApp",
      { appId: "deus.mobile-use", workspaceId },
      60_000
    );
    runningAppId = launchAck.runningAppId;
    if (!runningAppId || typeof launchAck.url !== "string") {
      throw new Error(`launchApp returned unexpected payload: ${JSON.stringify(launchAck)}`);
    }

    const launchUrl = new URL(launchAck.url);
    const health = await getJson(Number(launchUrl.port), "/health");
    if (health.statusCode !== 200) {
      throw new Error(
        `Mobile Use health check failed: ${health.statusCode} ${health.body.slice(0, 500)}`
      );
    }
    console.log(
      "[runtime-smoke] packaged backend AAP launch started Mobile Use through bundled runtime"
    );
  } finally {
    if (runningAppId) {
      await sendWsCommand(port, "stopApp", { runningAppId }, 15_000);
    }
  }
}

async function smokeAgentServer(runtimeBin, binDir) {
  await waitForRuntimePatterns(
    runtimeBin,
    ["agent-server"],
    binDir,
    [...bundledAgentCliPatterns(binDir), /LISTEN_URL=/],
    {
      obsoleteLabel: "Packaged runtime smoke",
      onReady: (output) =>
        assertInitializedAgentsFromOutput(
          output,
          "Packaged runtime output did not include LISTEN_URL"
        ),
    }
  );
  console.log(
    "[runtime-smoke] packaged runtime agent-server resolved bundled CLIs and initialized agents"
  );
}

async function smokeBackend(runtimeBin, binDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-packaged-runtime-"));
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
        obsoleteLabel: "Packaged runtime smoke",
        onReady: async (output) => {
          const port = readBackendPort(output);
          await assertBackendDbRouteFromOutput(output);
          await assertInitializedAgentsFromOutput(
            output,
            "Packaged backend runtime output did not include agent-server LISTEN_URL"
          );
          await smokeBackendCommands(port, dataDir);
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

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function smokeDeviceUseServe(runtimeBin) {
  const port = await allocatePort();
  const child = spawn(runtimeBin, ["device-use", "serve", "--port", String(port)], {
    cwd: path.dirname(runtimeBin),
    detached: process.platform !== "win32",
    env: runtimeEnv(null, {
      PATH: PACKAGED_SYSTEM_PATHS.join(path.delimiter),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `device-use exited before readiness: code=${child.exitCode} signal=${child.signalCode} stdout=${stdout} stderr=${stderr}`
        );
      }
      try {
        const response = await getJson(port, "/health");
        if (response.statusCode === 200) {
          console.log("[runtime-smoke] packaged runtime device-use serve reached /health");
          return;
        }
      } catch {
        // Not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for device-use /health stdout=${stdout} stderr=${stderr}`);
  } finally {
    await stopChild(child);
  }
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

  const deviceUseVersion = await runRuntimeCommand(runtimeBin, ["device-use", "--version"], binDir);
  if (!/^device-use \d+\.\d+\.\d+/.test(deviceUseVersion)) {
    throw new Error(`Unexpected packaged device-use version output: ${deviceUseVersion}`);
  }
  console.log(`[runtime-smoke] packaged runtime device-use command: ${deviceUseVersion}`);

  await smokeAgentServer(runtimeBin, binDir);
  await smokeBackend(runtimeBin, binDir);
  await smokeDeviceUseServe(runtimeBin);
}

smokePackagedRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
