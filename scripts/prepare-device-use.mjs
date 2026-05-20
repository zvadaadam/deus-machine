// Builds the device-use workspace package on install:
//   1. TypeScript → dist/ (via device-use's own build script)
//   2. Swift → native/.build/release/simbridge (via device-use's build-native)
//   3. Copies simbridge + siminspector into packages/device-use/bin/ (where
//      runtime code looks for it)
//
// Idempotent for expensive builds. Fresh installs can use already-staged
// helpers without requiring Swift; when helpers are missing, we build or copy
// from the current native output.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(rootDir, "packages", "device-use");

function log(msg) {
  console.log(`[prepare-device-use] ${msg}`);
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

if (!existsSync(pkgDir)) {
  log(`package not found at ${pkgDir}, skipping`);
  process.exit(0);
}

// 1. TypeScript/server build
const distDir = join(pkgDir, "dist");
const distOutputs = [
  join(distDir, "cli.js"),
  join(distDir, "cli-runtime.js"),
  join(distDir, "engine.js"),
  join(distDir, "server", "index.js"),
];
if (distOutputs.some((output) => !existsSync(output))) {
  log("building TypeScript (dist/)...");
  try {
    run("bun", ["run", "build:ts"], pkgDir);
  } catch (err) {
    log(`TypeScript build failed: ${err.message}`);
    process.exit(1);
  }
} else {
  log("dist/ already built, skipping");
}

const frontendIndex = join(distDir, "frontend", "index.html");
if (!existsSync(frontendIndex)) {
  log("building frontend (dist/frontend/)...");
  try {
    run("bun", ["run", "build:frontend"], pkgDir);
  } catch (err) {
    log(`frontend build failed: ${err.message}`);
    process.exit(1);
  }
} else {
  log("dist/frontend/ already built, skipping");
}

// 2. Native helpers (macOS only, Xcode CLT required)
const nativeDir = join(pkgDir, "native");
const releaseBinary = join(nativeDir, ".build", "release", "simbridge");
const universalBinary = join(nativeDir, ".build", "apple", "Products", "Release", "simbridge");
const releaseInspector = join(nativeDir, ".build", "release", "siminspector.dylib");
const binDir = join(pkgDir, "bin");
const binSimbridge = join(binDir, "simbridge");
const binSiminspector = join(binDir, "siminspector.dylib");

function hasRequiredMacArchitectures(binary) {
  if (process.platform !== "darwin") return true;
  try {
    const archs = execFileSync("lipo", ["-archs", binary], { encoding: "utf8" });
    return archs.includes("arm64") && archs.includes("x86_64");
  } catch {
    return false;
  }
}

function findSwiftBuildOutput() {
  if (existsSync(universalBinary)) return universalBinary;
  if (existsSync(releaseBinary) && hasRequiredMacArchitectures(releaseBinary)) {
    return releaseBinary;
  }

  const buildDir = join(nativeDir, ".build");
  if (!existsSync(buildDir)) return null;

  for (const entry of readdirSync(buildDir)) {
    if (!entry.endsWith("-apple-macosx")) continue;
    const candidate = join(buildDir, entry, "release", "simbridge");
    if (existsSync(candidate) && hasRequiredMacArchitectures(candidate)) return candidate;
  }

  return null;
}

function swiftAvailable() {
  try {
    execFileSync("swift", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function helperReady(filePath) {
  return existsSync(filePath) && hasRequiredMacArchitectures(filePath);
}

const stagedHelpersReady = helperReady(binSimbridge) && helperReady(binSiminspector);

if (stagedHelpersReady) {
  log("native simulator helpers already staged, skipping");
} else if (!findSwiftBuildOutput() || !existsSync(releaseInspector)) {
  if (process.platform !== "darwin") {
    log(
      "not on macOS and staged simulator helpers are missing; packaged macOS builds must stage them on macOS"
    );
  } else if (!swiftAvailable()) {
    log(
      "Swift not found (install Xcode CLT: xcode-select --install). Using any existing staged helpers."
    );
  } else {
    log("building native simulator helpers...");
    try {
      run("bun", ["run", "build:native"], pkgDir);
    } catch (err) {
      log(`native build failed: ${err.message}`);
      // Non-fatal: runtime will error clearly if a helper is missing
    }
  }
} else {
  log("native simulator helpers already built, skipping");
}

// 3. Copy native helpers into packages/device-use/bin/ for stable runtime path
const source = stagedHelpersReady ? null : findSwiftBuildOutput();

if (source) {
  mkdirSync(binDir, { recursive: true });
  copyFileSync(source, binSimbridge);
  try {
    // Preserve executable bit
    const mode = statSync(source).mode;
    chmodSync(binSimbridge, mode & 0o777);
  } catch {
    /* best effort */
  }
  log(`copied simbridge → ${binSimbridge}`);
} else if (helperReady(binSimbridge)) {
  log(`using staged simbridge at ${binSimbridge}`);
} else {
  log("simbridge build output not found; runtime will report a clear error if needed");
}

if (!stagedHelpersReady && existsSync(releaseInspector)) {
  mkdirSync(binDir, { recursive: true });
  copyFileSync(releaseInspector, binSiminspector);
  try {
    const mode = statSync(releaseInspector).mode;
    chmodSync(binSiminspector, mode & 0o777);
  } catch {
    /* best effort */
  }
  log(`copied siminspector → ${binSiminspector}`);
} else if (helperReady(binSiminspector)) {
  log(`using staged siminspector at ${binSiminspector}`);
} else {
  log("siminspector build output not found; runtime will report a clear error if needed");
}

if (process.platform === "darwin" && existsSync(binSiminspector)) {
  try {
    execFileSync("install_name_tool", ["-id", "@rpath/siminspector.dylib", binSiminspector], {
      stdio: "ignore",
    });
  } catch {
    log("could not normalize siminspector install name; packaged smoke will verify it");
  }
}

log("done");
