// Builds the device-use workspace package on install:
//   1. TypeScript → dist/ (via device-use's own build script)
//   2. Swift → native/.build/release/simbridge (via device-use's build-native)
//   3. Copies simbridge + siminspector into packages/device-use/bin/ (where
//      runtime code looks for it)
//
// Idempotent: skips each step if the output already exists.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
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

// 1. TypeScript build
const distDir = join(pkgDir, "dist");
const distEngine = join(distDir, "engine.js");
if (!existsSync(distEngine)) {
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

// 2. Native build (macOS only, Xcode CLT required)
const nativeDir = join(pkgDir, "native");
const releaseBinary = join(nativeDir, ".build", "release", "simbridge");
const releaseInspector = join(nativeDir, ".build", "release", "siminspector.dylib");
const archBinary = join(nativeDir, ".build", "arm64-apple-macosx", "release", "simbridge");

function swiftAvailable() {
  try {
    execFileSync("swift", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if ((!existsSync(releaseBinary) && !existsSync(archBinary)) || !existsSync(releaseInspector)) {
  if (process.platform !== "darwin") {
    log("not on macOS, skipping native build");
  } else if (!swiftAvailable()) {
    log("Swift not found (install Xcode CLT: xcode-select --install). Skipping.");
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
const binDir = join(pkgDir, "bin");
const binSimbridge = join(binDir, "simbridge");
const binSiminspector = join(binDir, "siminspector.dylib");
const source = existsSync(releaseBinary)
  ? releaseBinary
  : existsSync(archBinary)
    ? archBinary
    : null;

if (source && !existsSync(binSimbridge)) {
  mkdirSync(binDir, { recursive: true });
  copyFileSync(source, binSimbridge);
  try {
    // Preserve executable bit
    const mode = statSync(source).mode;
    execFileSync("chmod", [(mode & 0o777).toString(8), binSimbridge]);
  } catch {
    /* best effort */
  }
  log(`copied simbridge → ${binSimbridge}`);
} else if (existsSync(binSimbridge)) {
  log("bin/simbridge already present, skipping copy");
}

if (existsSync(releaseInspector) && !existsSync(binSiminspector)) {
  mkdirSync(binDir, { recursive: true });
  copyFileSync(releaseInspector, binSiminspector);
  try {
    const mode = statSync(releaseInspector).mode;
    execFileSync("chmod", [(mode & 0o777).toString(8), binSiminspector]);
  } catch {
    /* best effort */
  }
  log(`copied siminspector → ${binSiminspector}`);
} else if (existsSync(binSiminspector)) {
  log("bin/siminspector already present, skipping copy");
}

log("done");
