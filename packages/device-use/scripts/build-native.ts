#!/usr/bin/env bun
import { existsSync, copyFileSync, mkdirSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(here, "..", "native");
const buildDir = join(nativeDir, ".build");
const releaseDir = join(buildDir, "release");
const releaseBinary = join(releaseDir, "simbridge");
const archBinary = join(buildDir, "arm64-apple-macosx", "release", "simbridge");
const inspectorBinary = join(releaseDir, "siminspector.dylib");
const inspectorBuildScript = join(nativeDir, "Sources", "SimInspector", "build.sh");

const bridgeReady =
  existsSync(releaseBinary) &&
  !lstatSync(releaseDir).isSymbolicLink() &&
  !lstatSync(releaseBinary).isSymbolicLink();
const inspectorReady = existsSync(inspectorBinary);

if (bridgeReady && inspectorReady) {
  console.log("[build-native] simbridge already built, skipping.");
  console.log(`  ${releaseBinary}`);
  console.log("[build-native] siminspector already built, skipping.");
  console.log(`  ${inspectorBinary}`);
  process.exit(0);
}

try {
  await $`swift --version`.quiet();
} catch {
  console.warn("[build-native] Swift not found. simbridge will not be available.");
  console.warn("  Install Xcode Command Line Tools: xcode-select --install");
  process.exit(0);
}

if (!bridgeReady) {
  console.log("[build-native] Building simbridge...");
  try {
    await $`swift build -c release`.cwd(nativeDir);
    console.log("[build-native] Built simbridge successfully.");
  } catch (error) {
    console.warn("[build-native] simbridge build failed:", error);
    process.exit(0);
  }
}

// Swift creates .build/release as a symlink. Flatten to a real dir for packaging.
if (existsSync(releaseDir) && lstatSync(releaseDir).isSymbolicLink()) {
  unlinkSync(releaseDir);
}

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

if (existsSync(archBinary)) {
  copyFileSync(archBinary, releaseBinary);
}

console.log(`[build-native] Binary ready: ${releaseBinary}`);

if (!existsSync(inspectorBinary)) {
  console.log("[build-native] Building siminspector...");
  try {
    await $`bash ${inspectorBuildScript}`.cwd(nativeDir);
    console.log("[build-native] Built siminspector successfully.");
  } catch (error) {
    console.warn("[build-native] siminspector build failed:", error);
    process.exit(0);
  }
}

console.log(`[build-native] Dylib ready: ${inspectorBinary}`);
