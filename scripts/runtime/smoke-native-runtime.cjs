const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 5_000;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
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
  console.log(`Usage: node scripts/runtime/smoke-native-runtime.cjs [options]

Options:
  --runtime-key <key>      Staged runtime key, defaults to host key
  --skip-validate          Skip bun run validate:runtime before executing

Runs direct smokes against dist/runtime/electron/bin/<runtime-key>/deus-runtime:
--version, self-test, agent-server readiness, and backend readiness.`);
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

function runtimeEnv(binDir) {
  const env = {
    ...process.env,
    DEUS_BUNDLED_BIN_DIR: binDir,
    PATH: [binDir, ...PACKAGED_SYSTEM_PATHS].join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENT_SERVER_ENTRY;
  delete env.AGENT_SERVER_CWD;
  delete env.NODE_PATH;
  return env;
}

function runValidateRuntime() {
  execFileSync("bun", ["run", "validate:runtime"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
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

function runtimeDiagnostics(runtimeBin) {
  if (process.platform !== "darwin") return "";
  return [
    `file: ${runDiagnostic("file", [runtimeBin])}`,
    `codesign: ${runDiagnostic("codesign", ["-dv", "--verbose=4", runtimeBin])}`,
    `spctl: ${runDiagnostic("spctl", ["--assess", "--type", "execute", "--verbose=4", runtimeBin])}`,
    `xattr: ${runDiagnostic("xattr", ["-l", runtimeBin]) || "none"}`,
  ].join("\n");
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

async function waitForRuntimePatterns(runtimeBin, args, binDir, patterns) {
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
      const timeout = setTimeout(() => {
        const missing = patterns
          .filter((_, index) => !matched.has(index))
          .map((pattern) => pattern.toString());
        reject(
          new Error(
            `${path.basename(runtimeBin)} ${args.join(
              " "
            )} did not reach readiness. missing=${missing.join(", ") || "none"} stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}`
          )
        );
      }, STARTUP_TIMEOUT_MS);

      const fail = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      const maybeDone = () => {
        const output = `${stdout}\n${stderr}`;
        for (const pattern of OBSOLETE_RUNTIME_PATTERNS) {
          if (pattern.test(output)) {
            fail(new Error(`Native runtime smoke used obsolete runtime path: ${pattern}`));
            return;
          }
        }
        patterns.forEach((pattern, index) => {
          if (pattern.test(output)) matched.add(index);
        });
        if (matched.size === patterns.length) {
          clearTimeout(timeout);
          resolve();
        }
      };

      child.stdout.on("data", (data) => {
        stdout += data.toString();
        maybeDone();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
        maybeDone();
      });
      child.on("error", fail);
      child.on("exit", (code, signal) => {
        if (matched.size !== patterns.length) {
          fail(
            new Error(
              `${path.basename(runtimeBin)} ${args.join(
                " "
              )} exited before readiness: code=${code} signal=${signal} stdout=${stdout
                .trim()
                .slice(-4000)} stderr=${stderr.trim().slice(-4000)}`
            )
          );
        }
      });
    });
  } finally {
    await stopChild(child);
  }
}

async function smokeNativeRuntime(options) {
  if (!options.skipValidate) runValidateRuntime();

  const binDir = path.join(PROJECT_ROOT, "dist", "runtime", "electron", "bin", options.runtimeKey);
  const runtimeBin = path.join(binDir, "deus-runtime");
  assertExecutable(runtimeBin, `staged ${options.runtimeKey} Deus runtime`);

  const version = runRuntime(runtimeBin, ["--version"], binDir);
  if (!new RegExp(`^deus-runtime \\d+\\.\\d+\\.\\d+ ${options.runtimeKey}$`).test(version)) {
    throw new Error(`Unexpected staged runtime version output: ${version}`);
  }
  console.log(`[runtime-smoke] native runtime version: ${version}`);

  const selfTest = JSON.parse(runRuntime(runtimeBin, ["self-test"], binDir));
  if (selfTest.ok !== true) {
    throw new Error(`Native runtime self-test failed: ${JSON.stringify(selfTest)}`);
  }
  console.log(`[runtime-smoke] native runtime self-test binDir: ${selfTest.binDir}`);

  await waitForRuntimePatterns(runtimeBin, ["agent-server"], binDir, [
    ...BUNDLED_AGENT_CLI_PATTERNS,
    /LISTEN_URL=/,
  ]);
  console.log("[runtime-smoke] native runtime agent-server resolved bundled CLIs");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deus-native-runtime-"));
  try {
    await waitForRuntimePatterns(runtimeBin, ["backend", "--data-dir", dataDir], binDir, [
      /^\[agent-server\] BUNDLED_CLI_PATH claude=.*\/claude/m,
      /^\[agent-server\] BUNDLED_CLI_PATH codex=.*\/codex/m,
      /^\[agent-server\] LISTEN_URL=/m,
      /^\[BACKEND_PORT\]\d+/m,
    ]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log("[runtime-smoke] native runtime backend resolved bundled CLIs and reached port");
}

smokeNativeRuntime(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(error);
  process.exit(1);
});
