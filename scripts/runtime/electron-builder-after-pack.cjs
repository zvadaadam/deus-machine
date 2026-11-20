const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  DEVICE_USE_HELPER_NAMES,
  assertNoBuildLocalInstallName,
  packagedSimulatorDir,
} = require("./lib/device-use-payloads.cjs");
const { readLockedPackage, verifyIntegrity } = require("./lib/locked-package.cjs");

const ARCH_BY_BUILDER_VALUE = new Map([
  [1, "x64"],
  [3, "arm64"],
  ["x64", "x64"],
  ["arm64", "arm64"],
]);
// What `file` says of a target's executables: the targets Deus packages.
const FILE_TYPE_BY_RUNTIME_KEY = new Map([
  ["darwin-x64", ["Mach-O 64-bit", "x86_64"]],
  ["darwin-arm64", ["Mach-O 64-bit", "arm64"]],
  ["linux-x64", ["ELF 64-bit", "x86-64"]],
]);
const PACKAGE_RECOVERY_TIMEOUT_MS = 60_000;
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// The executables Resources/bin ships, built for their target, and the CLIs:
// those and agent-device, a script that runs its package (agent-device-package/)
// with deus-runtime. The packaged runtime smoke runs each CLI; electron-builder.yml's
// filters, which cannot read this, copy them.
const BUNDLED_BINARIES = ["deus-runtime", "gh", "codex", "claude", "rg", "agent-browser"];
const BUNDLED_CLIS = [...BUNDLED_BINARIES, "agent-device"];

function codexHelpers(runtimeKey) {
  return [
    "codex-runtime/bin/codex-code-mode-host",
    // Codex 0.169.1 ships no zsh of its own (0.160.0 did, in codex-resources/zsh).
    ...(runtimeKey.startsWith("linux-") ? ["codex-runtime/codex-resources/bwrap"] : []),
  ];
}

function resourcesDirForContext(context) {
  const productName = context.packager?.appInfo?.productFilename ?? "Deus";
  if (context.electronPlatformName === "darwin") {
    return path.join(context.appOutDir, `${productName}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function pruneCanvasRuntimeBinaries(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "linux") {
    return { removed: 0, kept: 0 };
  }

  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!targetArch) return { removed: 0, kept: 0 };

  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const napiRsRoot = path.join(resourcesDir, "app.asar.unpacked", "node_modules", "@napi-rs");
  if (!fs.existsSync(napiRsRoot)) return { removed: 0, kept: 0 };

  const targetPackageName =
    context.electronPlatformName === "linux"
      ? `canvas-linux-${targetArch}-gnu`
      : `canvas-darwin-${targetArch}`;
  let removed = 0;
  let kept = 0;
  for (const entry of fs.readdirSync(napiRsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("canvas-")) continue;
    const entryPath = path.join(napiRsRoot, entry.name);
    if (entry.name === targetPackageName) {
      kept++;
      continue;
    }
    fs.rmSync(entryPath, { recursive: true, force: true });
    removed++;
  }

  if (removed > 0 || kept > 0) {
    console.log(
      `[runtime] kept @napi-rs/${targetPackageName}; removed ${removed} non-runtime canvas native dirs`
    );
  }
  return { removed, kept };
}

function ensureCanvasRuntimePackage(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "linux") {
    return { installed: false };
  }
  const targetArch = ARCH_BY_BUILDER_VALUE.get(context.arch);
  if (!targetArch) return { installed: false };
  const packageName =
    context.electronPlatformName === "linux"
      ? `@napi-rs/canvas-linux-${targetArch}-gnu`
      : `@napi-rs/canvas-darwin-${targetArch}`;
  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const packageRoot = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    ...packageName.split("/")
  );
  if (fs.existsSync(path.join(packageRoot, "package.json"))) return { installed: false };

  const lockedPackage = readLockedPackage(PROJECT_ROOT, packageName);
  const tempRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "deus-canvas-"));
  const tarballPath = path.join(tempRoot, "package.tgz");
  try {
    console.log(`[runtime] installing missing ${packageName} from lockfile`);
    execFileSync("curl", ["-fsSL", lockedPackage.url, "-o", tarballPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PACKAGE_RECOVERY_TIMEOUT_MS,
    });
    verifyIntegrity(fs.readFileSync(tarballPath), lockedPackage);
    execFileSync("tar", ["-xzf", tarballPath, "-C", tempRoot], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PACKAGE_RECOVERY_TIMEOUT_MS,
    });
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
    fs.cpSync(path.join(tempRoot, "package"), packageRoot, { recursive: true });
    return { installed: true };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * What no launch on the build machine shows, read from the packaged layout:
 * every executable is there and built for its target (the x64 app is packaged
 * on an arm64 runner), Codex is the version the engine runs (the engine runs
 * whatever it is handed) with its aliases inside its package, deus-runtime
 * links only system libraries, and the simulator helpers carry both
 * architectures.
 */
function verifyPackagedLayout(context) {
  const runtimeKey = `${context.electronPlatformName}-${ARCH_BY_BUILDER_VALUE.get(context.arch)}`;
  const fileType = FILE_TYPE_BY_RUNTIME_KEY.get(runtimeKey);
  if (!fileType) throw new Error(`Deus packages no runtime for ${runtimeKey}`);
  const [platform, arch] = runtimeKey.split("-");
  const resourcesDir = context.resourcesDir ?? resourcesDirForContext(context);
  const binDir = path.join(resourcesDir, "bin");
  const canvas =
    platform === "linux"
      ? `canvas-linux-${arch}-gnu/skia.linux-${arch}-gnu.node`
      : `canvas-darwin-${arch}/skia.darwin-${arch}.node`;
  // The app's own executable: Contents/MacOS/<productFilename>, or Linux's
  // <executableName> beside resources/ (electron-builder's LinuxPackager names it).
  const appExecutable =
    platform === "darwin"
      ? path.join(resourcesDir, "..", "MacOS", context.packager?.appInfo?.productFilename ?? "Deus")
      : path.join(resourcesDir, "..", context.packager?.executableName ?? "deus");
  const executables = [
    appExecutable,
    ...[...BUNDLED_BINARIES, ...codexHelpers(runtimeKey)].map((name) => path.join(binDir, name)),
  ];
  for (const file of [
    ...executables,
    path.join(resourcesDir, "app.asar.unpacked", "node_modules", "@napi-rs", canvas),
  ]) {
    // -b: without the file's name, which holds the architecture too (dist-electron/mac-arm64).
    const description = execFileSync("file", ["-b", "-L", file], { encoding: "utf8" }).trim();
    if (!fileType.every((token) => description.includes(token))) {
      throw new Error(`Packaged ${file} is not ${fileType.join(" ")}: ${description}`);
    }
    if (executables.includes(file) && (fs.statSync(file).mode & 0o111) === 0) {
      throw new Error(`Packaged ${file} is not executable`);
    }
  }

  const codex = JSON.parse(
    fs.readFileSync(path.join(binDir, "codex-runtime", "codex-package.json"), "utf8")
  );
  const pinned = execFileSync(
    "bun",
    ["-e", 'console.log((await import("@zvada/agent-server/core")).DEFAULT_PINS.codex)'],
    { cwd: PROJECT_ROOT, encoding: "utf8" }
  ).trim();
  if (codex.version !== pinned) {
    throw new Error(
      `Packaged Codex is ${codex.version}, but agent-server runs ${pinned}: run \`bun run build:runtime\``
    );
  }
  // Codex finds its helpers and resources beside the executable an alias resolves to.
  for (const [alias, entry] of [
    ["codex", "bin/codex"],
    ["rg", "codex-path/rg"],
  ]) {
    if (
      fs.realpathSync(path.join(binDir, alias)) !==
      fs.realpathSync(path.join(binDir, "codex-runtime", entry))
    ) {
      throw new Error(`Packaged ${alias} must resolve inside the Codex package`);
    }
  }

  if (platform === "darwin") {
    const foreignLibraries = execFileSync("otool", ["-L", path.join(binDir, "deus-runtime")], {
      encoding: "utf8",
    })
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((library) => library && !/^\/(usr\/lib|System\/Library)\//.test(library));
    if (foreignLibraries.length > 0) {
      throw new Error(`Packaged deus-runtime links outside macOS: ${foreignLibraries.join(", ")}`);
    }
    const simulatorDir = packagedSimulatorDir(resourcesDir);
    for (const name of Object.values(DEVICE_USE_HELPER_NAMES)) {
      // One architecture a call: the lipo of macOS 27 reads a second one as a file.
      for (const lipoArch of ["arm64", "x86_64"]) {
        execFileSync("lipo", [path.join(simulatorDir, name), "-verify_arch", lipoArch], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      }
    }
    assertNoBuildLocalInstallName(
      path.join(simulatorDir, DEVICE_USE_HELPER_NAMES.siminspector),
      PROJECT_ROOT,
      "Packaged siminspector"
    );
  }
  console.log(`[runtime] packaged ${runtimeKey} layout verified`);
}

module.exports = async function afterPack(context) {
  ensureCanvasRuntimePackage(context);
  pruneCanvasRuntimeBinaries(context);
  verifyPackagedLayout(context);
};

module.exports.BUNDLED_CLIS = BUNDLED_CLIS;
module.exports.pruneCanvasRuntimeBinaries = pruneCanvasRuntimeBinaries;
module.exports.verifyPackagedLayout = verifyPackagedLayout;
