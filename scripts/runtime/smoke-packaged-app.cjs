const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");
const {
  verifyCodeSignaturePageSize,
  verifyPackagedAgentClis,
} = require("../prune-pencil-cli-binaries.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_APP_PATH = path.join(PROJECT_ROOT, "dist-electron", "mac-arm64", "Deus.app");
const REQUIRED_BINARIES = ["deus-runtime", "codex", "claude", "gh", "rg"];
const REQUIRED_MANIFESTS = ["deus-runtime.json", "agent-clis.json", "gh-cli.json"];

function parseArgs(argv) {
  const options = {
    appPath: null,
    arch: null,
    runVersionChecks: false,
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

  options.appPath = path.resolve(options.appPath ?? DEFAULT_APP_PATH);
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/runtime/smoke-packaged-app.cjs [app-path]

Options:
  --app <path>                 Path to the packaged .app bundle
  --arch <arm64|x64>           Expected macOS runtime architecture
  --run-version-checks         Execute packaged --version checks
  --verify-manifest-hashes     Verify packaged binary hashes against manifests

By default this smoke inspects the packaged app statically and does not execute
generated/copied Mach-O binaries. Use --run-version-checks on hosts where the
packaged binaries can be launched directly.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDirectory(dirPath, label) {
  assert(fs.existsSync(dirPath), `Missing ${label}: ${dirPath}`);
  assert(fs.statSync(dirPath).isDirectory(), `${label} is not a directory: ${dirPath}`);
}

function assertRegularExecutable(filePath, label) {
  assert(fs.existsSync(filePath), `Missing ${label}: ${filePath}`);
  const stat = fs.statSync(filePath);
  assert(stat.isFile(), `${label} is not a regular file: ${filePath}`);
  assert((stat.mode & 0o111) !== 0, `${label} is not executable: ${filePath}`);
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

function verifyAsarRuntimeContract(asarPath) {
  assert(fs.existsSync(asarPath), `Missing packaged app.asar: ${asarPath}`);

  const entries = new Set(asar.listPackage(asarPath));
  for (const entry of ["/out/main/index.js", "/out/preload/index.mjs", "/out/renderer/index.html"]) {
    assert(entries.has(entry), `Packaged app.asar is missing ${entry}`);
  }

  const mainOutput = asar.extractFile(asarPath, "out/main/index.js").toString("utf8");
  const requiredSnippets = [
    "deus-runtime",
    "DEUS_RUNTIME_EXECUTABLE",
    "configurePackagedMainRuntimeEnv",
  ];
  for (const snippet of requiredSnippets) {
    assert(
      mainOutput.includes(snippet),
      `Packaged Electron main output is missing runtime contract snippet: ${snippet}`
    );
  }

  const obsoleteSnippets = [
    'process.resourcesPath, "backend"',
    "process.resourcesPath, 'backend'",
    "runtime.nodePath",
    "NODE_PATH: runtime.nodePath",
  ];
  for (const snippet of obsoleteSnippets) {
    assert(
      !mainOutput.includes(snippet),
      `Packaged Electron main output still contains obsolete runtime snippet: ${snippet}`
    );
  }

  console.log("[runtime-smoke] packaged app.asar runtime contract verified");
}

function verifyPackagedApp(options) {
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
    assert(fs.existsSync(path.join(binDir, name)), `Missing packaged manifest: ${name}`);
  }

  verifyAppSignature(appPath, appExecutable);
  verifyPackagedAgentClis(
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

  console.log(`[runtime-smoke] packaged app verified: ${appPath}`);
}

try {
  verifyPackagedApp(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error);
  process.exit(1);
}
