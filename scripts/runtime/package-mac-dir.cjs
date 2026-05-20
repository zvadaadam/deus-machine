const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ELECTRON_DIST = path.join(PROJECT_ROOT, "node_modules", "electron", "dist");
const ELECTRON_APP = path.join(ELECTRON_DIST, "Electron.app");
const ELECTRON_EXECUTABLE = path.join(ELECTRON_APP, "Contents", "MacOS", "Electron");
const SUPPORTED_ARCHES = new Set(["arm64", "x64"]);

function parseArgs(argv) {
  const options = {
    arch:
      process.platform === "darwin" && SUPPORTED_ARCHES.has(process.arch) ? process.arch : "arm64",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--arch") {
      if (index + 1 >= argv.length) {
        throw new Error("Missing value for --arch");
      }
      options.arch = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!SUPPORTED_ARCHES.has(options.arch)) {
    throw new Error(`Unsupported macOS dir package arch: ${options.arch}`);
  }
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/runtime/package-mac-dir.cjs [--arch arm64|x64]

Creates a narrow macOS .app directory package for runtime smoke verification.
This still runs electron-builder beforePack/afterPack/afterSign hooks, but uses
the installed unpacked Electron.app for the selected host architecture.`);
}

function assertHostPlatform() {
  if (process.platform !== "darwin") {
    throw new Error("package-mac-dir requires macOS");
  }
}

function fileOutput(filePath) {
  return execFileSync("file", [filePath], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertElectronDistArch(arch) {
  if (!fs.existsSync(ELECTRON_EXECUTABLE)) {
    throw new Error(`Missing installed Electron runtime: ${ELECTRON_EXECUTABLE}`);
  }

  const output = fileOutput(ELECTRON_EXECUTABLE);
  const expectedToken = arch === "arm64" ? "arm64" : "x86_64";
  if (!output.includes(expectedToken)) {
    throw new Error(
      `Installed Electron runtime does not match --arch ${arch}: ${output}. ` +
        "Run this smoke on a matching host architecture or provide a matching Electron dist."
    );
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function valuesAfter(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function resolveIconInput(args) {
  const roots = valuesAfter(args, "--root");
  const candidates = [...valuesAfter(args, "--input"), ...valuesAfter(args, "--fallback-input")];
  for (const candidate of candidates) {
    const absoluteCandidates = path.isAbsolute(candidate)
      ? [candidate]
      : roots.map((root) => path.resolve(PROJECT_ROOT, root, candidate));
    for (const absolutePath of absoluteCandidates) {
      if (fs.existsSync(absolutePath)) return absolutePath;
    }
  }
  throw new Error(`Unable to resolve electron-builder icon input from: ${args.join(" ")}`);
}

function installIconResolver() {
  const appBuilder = require("app-builder-lib/out/util/appBuilder");
  if (!appBuilder || typeof appBuilder.executeAppBuilderAsJson !== "function") {
    throw new Error(
      "electron-builder internal API executeAppBuilderAsJson not found; " +
        "package-mac-dir requires electron-builder ^26.0.0"
    );
  }
  const realExecuteAppBuilderAsJson = appBuilder.executeAppBuilderAsJson;

  appBuilder.executeAppBuilderAsJson = async function executeAppBuilderAsJson(args) {
    if (args[0] !== "icon") return realExecuteAppBuilderAsJson(args);

    const out = valueAfter(args, "--out");
    if (!out) throw new Error(`electron-builder icon command is missing --out: ${args.join(" ")}`);

    const outPath = path.resolve(PROJECT_ROOT, out);
    const input = resolveIconInput(args);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(input, outPath);
    return {
      icons: [{ file: outPath }],
      isFallback: false,
    };
  };
}

function prepareDeviceUsePayloads() {
  execFileSync("bun", ["run", "prepare:device-use", "--force"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

async function main() {
  assertHostPlatform();
  const options = parseArgs(process.argv.slice(2));
  assertElectronDistArch(options.arch);
  prepareDeviceUsePayloads();
  installIconResolver();

  const { Arch, Platform, build } = require("electron-builder");
  await build({
    targets: Platform.MAC.createTarget(["dir"], Arch[options.arch]),
    publish: "never",
    config: {
      electronDist: path.relative(PROJECT_ROOT, ELECTRON_DIST),
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
