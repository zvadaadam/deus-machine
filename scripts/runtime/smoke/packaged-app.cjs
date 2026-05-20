const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const {
  verifyCodeSignaturePageSize,
  verifyPackagedAgentClis,
} = require("../../prune-pencil-cli-binaries.cjs");
const { assertPackagedMainRuntimeContents } = require("../electron-builder-before-pack.cjs");
const {
  PROJECT_ROOT,
  RUNTIME_BINARIES,
  RUNTIME_MANIFESTS,
  assert,
  assertDirectory,
  assertExecutable: assertRegularExecutable,
  assertRegularFile,
  resolveDefaultAppPath,
} = require("./lib/smoke-helpers.cjs");
const {
  DEVICE_USE_HELPER_NAMES,
  DEVICE_USE_PACKAGE_FILES,
  assertNoBuildLocalInstallName,
  packagedDeviceUseRoot,
  packagedSimulatorDir,
} = require("../lib/device-use-payloads.cjs");

const DEFAULT_APP_PATH = resolveDefaultAppPath();
const REQUIRED_BINARIES = RUNTIME_BINARIES;
const REQUIRED_MANIFESTS = RUNTIME_MANIFESTS;
const ALLOWED_BIN_ENTRIES = new Set([...REQUIRED_BINARIES, ...REQUIRED_MANIFESTS]);
const FORBIDDEN_RUNTIME_PACKAGE_PREFIXES = [
  "/node_modules/@anthropic-ai/claude-agent-sdk-darwin-",
  "/node_modules/@anthropic-ai/claude-agent-sdk-linux-",
  "/node_modules/@anthropic-ai/claude-agent-sdk-win32-",
  "/node_modules/@openai/codex-darwin-",
  "/node_modules/@openai/codex-linux-",
  "/node_modules/@openai/codex-win32-",
  "/node_modules/@sentry/cli-",
];
const FORBIDDEN_RUNTIME_PACKAGE_ROOTS = [
  "/node_modules/@openai/codex/bin",
  "/node_modules/@openai/codex/vendor",
  "/node_modules/agent-browser",
  "/node_modules/@sentry/cli",
];

function parseArgs(argv) {
  const options = {
    appPath: null,
    arch: null,
    requireGatekeeper: false,
    runVersionChecks: false,
    skipAppSignature: false,
    verifyManifestHashes: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--app") {
      options.appPath = argv[++index];
    } else if (arg === "--arch") {
      options.arch = argv[++index];
    } else if (arg === "--run-version-checks") {
      options.runVersionChecks = true;
    } else if (arg === "--require-gatekeeper") {
      options.requireGatekeeper = true;
    } else if (arg === "--skip-app-signature") {
      options.skipAppSignature = true;
    } else if (arg === "--verify-manifest-hashes") {
      options.verifyManifestHashes = true;
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

  if (options.arch && options.arch !== "arm64" && options.arch !== "x64") {
    throw new Error(`Unsupported arch: ${options.arch}`);
  }
  if (options.requireGatekeeper && options.skipAppSignature) {
    throw new Error("--require-gatekeeper cannot be combined with --skip-app-signature");
  }

  options.appPath = path.resolve(options.appPath ?? DEFAULT_APP_PATH);
  return options;
}

function printUsage() {
  console.log(`Usage: bun run smoke:packaged-app -- [app-path]

Options:
  --app <path>                 Path to the packaged .app bundle
  --arch <arm64|x64>           Expected macOS runtime architecture
  --run-version-checks         Execute packaged --version checks
  --require-gatekeeper         Require spctl execute assessment to pass
  --skip-app-signature         Skip the app bundle code-signature check
  --verify-manifest-hashes     Verify pre-sign binary hashes against manifests

By default this smoke inspects the packaged app statically and does not execute
generated/copied Mach-O binaries. Use --run-version-checks on hosts where the
packaged binaries can be launched directly. Use --require-gatekeeper on
notarized release artifacts, not local ad-hoc or unnotarized builds.
Use --skip-app-signature only for unsigned PR package-dir builds; release
artifacts must keep the default app signature check.
Do not use --verify-manifest-hashes on signed apps; electron-builder re-signing
mutates Mach-O bytes after afterPack verifies the copied files.`);
}

function verifyResourcesBinContents(binDir) {
  const unexpected = fs
    .readdirSync(binDir)
    .filter((entry) => entry !== ".DS_Store" && !ALLOWED_BIN_ENTRIES.has(entry));
  assert(
    unexpected.length === 0,
    `Packaged Resources/bin contains unexpected entries: ${unexpected.join(", ")}`
  );
  console.log("[runtime-smoke] packaged Resources/bin contents verified");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function readPlistValue(plistPath, key) {
  return run("plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function fileOutput(filePath) {
  return run("file", [filePath]);
}

function archFromFileOutput(output, label) {
  if (output.includes("arm64")) return "arm64";
  if (output.includes("x86_64")) return "x64";
  throw new Error(`Unable to infer ${label} architecture from: ${output}`);
}

function assertMachOArch(filePath, label, expectedArch) {
  const output = fileOutput(filePath);
  const expectedToken = expectedArch === "arm64" ? "arm64" : "x86_64";
  assert(output.includes("Mach-O 64-bit"), `${label} is not a Mach-O 64-bit file: ${output}`);
  assert(
    output.includes(expectedToken),
    `${label} has unexpected architecture; expected ${expectedArch}: ${output}`
  );
  console.log(`[runtime-smoke] ${label}: ${output}`);
}

function verifyAppSignature(appPath, appExecutable) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  verifyCodeSignaturePageSize(appExecutable, "Deus app executable");
  console.log("[runtime-smoke] app code signature verified");
}

function verifyRuntimeManifestPackageVersion(binDir) {
  const packageJson = readJsonFile(path.join(PROJECT_ROOT, "package.json"), "package.json");
  const runtimeManifest = readJsonFile(
    path.join(binDir, "deus-runtime.json"),
    "packaged Deus runtime manifest"
  );
  assert(
    runtimeManifest.packageVersion === packageJson.version,
    `Packaged Deus runtime manifest version mismatch; expected ${packageJson.version}, found ${
      runtimeManifest.packageVersion ?? "missing"
    }`
  );
  console.log("[runtime-smoke] packaged runtime manifest package version verified");
}

function verifyGatekeeperAssessment(appPath) {
  execFileSync("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  console.log("[runtime-smoke] app Gatekeeper execute assessment verified");
}

function verifyAsarRuntimeContract(asarPath) {
  assert(fs.existsSync(asarPath), `Missing packaged app.asar: ${asarPath}`);

  const entries = new Set(asar.listPackage(asarPath));
  for (const entry of [
    "/out/main/index.js",
    "/out/preload/index.mjs",
    "/out/renderer/index.html",
  ]) {
    assert(entries.has(entry), `Packaged app.asar is missing ${entry}`);
  }

  const mainOutput = asar.extractFile(asarPath, "out/main/index.js").toString("utf8");
  assertPackagedMainRuntimeContents(mainOutput, "Packaged Electron main output");

  console.log("[runtime-smoke] packaged app.asar runtime contract verified");
}

function verifyNoDuplicateRuntimeCliPackages(resourcesDir) {
  const asarPath = path.join(resourcesDir, "app.asar");
  assert(fs.existsSync(asarPath), `Missing packaged app.asar: ${asarPath}`);

  const isForbiddenAsarEntry = (entry) =>
    FORBIDDEN_RUNTIME_PACKAGE_PREFIXES.some((prefix) => entry.startsWith(prefix)) ||
    FORBIDDEN_RUNTIME_PACKAGE_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`));
  const duplicateAsarEntries = asar.listPackage(asarPath).filter(isForbiddenAsarEntry);
  assert(
    duplicateAsarEntries.length === 0,
    "Packaged app.asar contains duplicate runtime CLI package payloads outside Resources/bin:\n" +
      duplicateAsarEntries.slice(0, 20).join("\n")
  );

  const unpackedNodeModules = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  if (fs.existsSync(unpackedNodeModules)) {
    const duplicateUnpackedRoots = [
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-darwin-arm64"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-darwin-x64"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-linux-arm64"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-linux-arm64-musl"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-linux-x64"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-linux-x64-musl"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-win32-arm64"),
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-win32-x64"),
      path.join(unpackedNodeModules, "@openai", "codex", "bin"),
      path.join(unpackedNodeModules, "@openai", "codex", "vendor"),
      path.join(unpackedNodeModules, "@openai", "codex-darwin-arm64"),
      path.join(unpackedNodeModules, "@openai", "codex-darwin-x64"),
      path.join(unpackedNodeModules, "@openai", "codex-linux-arm64"),
      path.join(unpackedNodeModules, "@openai", "codex-linux-x64"),
      path.join(unpackedNodeModules, "@openai", "codex-win32-arm64"),
      path.join(unpackedNodeModules, "@openai", "codex-win32-x64"),
      path.join(unpackedNodeModules, "agent-browser"),
      path.join(unpackedNodeModules, "@sentry", "cli"),
      path.join(unpackedNodeModules, "@sentry", "cli-darwin"),
      path.join(unpackedNodeModules, "@sentry", "cli-linux-arm"),
      path.join(unpackedNodeModules, "@sentry", "cli-linux-arm64"),
      path.join(unpackedNodeModules, "@sentry", "cli-linux-i686"),
      path.join(unpackedNodeModules, "@sentry", "cli-linux-x64"),
      path.join(unpackedNodeModules, "@sentry", "cli-win32-arm64"),
      path.join(unpackedNodeModules, "@sentry", "cli-win32-i686"),
      path.join(unpackedNodeModules, "@sentry", "cli-win32-x64"),
    ].filter((entryPath) => fs.existsSync(entryPath));

    assert(
      duplicateUnpackedRoots.length === 0,
      "Packaged app.asar.unpacked contains duplicate runtime CLI package payloads outside Resources/bin:\n" +
        duplicateUnpackedRoots.join("\n")
    );
  }

  console.log("[runtime-smoke] duplicate runtime CLI package payloads absent");
}

function verifyMacUniversalBinary(filePath, label, options) {
  assertRegularExecutable(filePath, label);
  const output = fileOutput(filePath);
  assert(
    output.includes("Mach-O") && output.includes("arm64") && output.includes("x86_64"),
    `${label} is not a universal arm64/x86_64 Mach-O binary: ${output}`
  );
  execFileSync("lipo", [filePath, "-verify_arch", "arm64", "x86_64"], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "ignore", "pipe"],
  });

  if (!options.skipAppSignature) {
    execFileSync("codesign", ["--verify", "--verbose=2", filePath], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    verifyCodeSignaturePageSize(filePath, label);
  }
  console.log(`[runtime-smoke] ${label}: ${output}`);
}

function verifyPackagedDeviceUse(resourcesDir, options) {
  const simulatorDir = packagedSimulatorDir(resourcesDir);
  const appRoot = packagedDeviceUseRoot(resourcesDir);

  assertDirectory(simulatorDir, "packaged simulator helper directory");
  verifyMacUniversalBinary(
    path.join(simulatorDir, DEVICE_USE_HELPER_NAMES.simbridge),
    "packaged simulator simbridge",
    options
  );
  const simulatorInspector = path.join(simulatorDir, DEVICE_USE_HELPER_NAMES.siminspector);
  verifyMacUniversalBinary(simulatorInspector, "packaged simulator siminspector", options);
  assertNoBuildLocalInstallName(
    simulatorInspector,
    PROJECT_ROOT,
    "packaged simulator siminspector"
  );

  assertDirectory(appRoot, "packaged device-use app");
  for (const [, relativePath] of DEVICE_USE_PACKAGE_FILES) {
    assertRegularFile(path.join(appRoot, relativePath), `packaged device-use ${relativePath}`);
  }
  verifyMacUniversalBinary(
    path.join(appRoot, "bin", DEVICE_USE_HELPER_NAMES.simbridge),
    "packaged device-use app simbridge",
    options
  );
  const appInspector = path.join(appRoot, "bin", DEVICE_USE_HELPER_NAMES.siminspector);
  verifyMacUniversalBinary(appInspector, "packaged device-use app siminspector", options);
  assertNoBuildLocalInstallName(appInspector, PROJECT_ROOT, "packaged device-use app siminspector");

  for (const forbidden of [
    path.join(appRoot, "native", ".build"),
    path.join(appRoot, "native", ".swiftpm"),
  ]) {
    assert(
      !fs.existsSync(forbidden),
      `Packaged device-use contains generated native build output: ${forbidden}`
    );
  }

  const manifest = readJsonFile(
    path.join(appRoot, "agentic-app.json"),
    "packaged device-use manifest"
  );
  assert(
    manifest.launch?.command === "device-use",
    `Packaged device-use manifest has unexpected launch command: ${manifest.launch?.command}`
  );
  assert(
    Array.isArray(manifest.launch?.args) &&
      manifest.launch.args.includes("--host") &&
      manifest.launch.args.includes("127.0.0.1"),
    "Packaged device-use manifest must bind AAP-launched Mobile Use to loopback"
  );
  console.log("[runtime-smoke] packaged device-use runtime payload verified");
}

async function verifyPackagedApp(options) {
  const appPath = options.appPath;
  assertDirectory(appPath, "packaged app bundle");
  assert(appPath.endsWith(".app"), `Expected a macOS .app bundle: ${appPath}`);

  const contentsDir = path.join(appPath, "Contents");
  const resourcesDir = path.join(contentsDir, "Resources");
  const binDir = path.join(resourcesDir, "bin");
  const infoPlist = path.join(contentsDir, "Info.plist");
  assert(fs.existsSync(infoPlist), `Missing app Info.plist: ${infoPlist}`);
  assertDirectory(resourcesDir, "packaged Resources directory");
  assertDirectory(binDir, "packaged Resources/bin directory");
  verifyResourcesBinContents(binDir);

  const bundleExecutable = readPlistValue(infoPlist, "CFBundleExecutable");
  const appExecutable = path.join(contentsDir, "MacOS", bundleExecutable);
  assertRegularExecutable(appExecutable, "packaged app executable");

  const runtimeExecutable = path.join(binDir, "deus-runtime");
  assertRegularExecutable(runtimeExecutable, "packaged Deus runtime");
  const arch = options.arch ?? archFromFileOutput(fileOutput(runtimeExecutable), "Deus runtime");

  assertMachOArch(appExecutable, "Deus app executable", arch);
  for (const name of REQUIRED_BINARIES) {
    assertRegularExecutable(path.join(binDir, name), `packaged ${name}`);
  }
  for (const name of REQUIRED_MANIFESTS) {
    assertRegularFile(path.join(binDir, name), `packaged manifest ${name}`);
  }

  if (!options.skipAppSignature) {
    verifyAppSignature(appPath, appExecutable);
  } else {
    console.log("[runtime-smoke] app code signature check skipped");
  }
  verifyRuntimeManifestPackageVersion(binDir);
  if (options.requireGatekeeper) {
    verifyGatekeeperAssessment(appPath);
  }
  await verifyPackagedAgentClis(
    {
      electronPlatformName: "darwin",
      arch,
      resourcesDir,
    },
    {
      runVersionChecks: options.runVersionChecks,
      verifyManifestHashes: options.verifyManifestHashes,
    }
  );
  verifyAsarRuntimeContract(path.join(resourcesDir, "app.asar"));
  verifyNoDuplicateRuntimeCliPackages(resourcesDir);
  verifyPackagedDeviceUse(resourcesDir, options);

  console.log(`[runtime-smoke] packaged app verified: ${appPath}`);
}

async function main() {
  await verifyPackagedApp(parseArgs(process.argv.slice(2)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
