#!/usr/bin/env bun
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  unlinkSync,
  lstatSync,
  readdirSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(here, "..", "native");
const buildDir = join(nativeDir, ".build");
const releaseDir = join(buildDir, "release");
const releaseBinary = join(releaseDir, "simbridge");
const universalBinary = join(buildDir, "apple", "Products", "Release", "simbridge");
const inspectorBinary = join(releaseDir, "siminspector.dylib");
const inspectorBuildScript = join(nativeDir, "Sources", "SimInspector", "build.sh");

function hasRequiredMacArchitectures(binary: string): boolean {
  if (process.platform !== "darwin") return true;
  try {
    const archs = execFileSync("lipo", ["-archs", binary], { encoding: "utf8" });
    return archs.includes("arm64") && archs.includes("x86_64");
  } catch {
    return false;
  }
}

function findSwiftBuildOutput(): string | null {
  if (existsSync(universalBinary)) return realpathSync(universalBinary);
  if (existsSync(releaseBinary) && hasRequiredMacArchitectures(releaseBinary)) {
    return realpathSync(releaseBinary);
  }
  if (!existsSync(buildDir)) return null;

  for (const entry of readdirSync(buildDir)) {
    if (!entry.endsWith("-apple-macosx")) continue;
    const candidate = join(buildDir, entry, "release", "simbridge");
    if (existsSync(candidate) && hasRequiredMacArchitectures(candidate)) return candidate;
  }

  return null;
}

const bridgeReady =
  existsSync(releaseBinary) &&
  !lstatSync(releaseDir).isSymbolicLink() &&
  !lstatSync(releaseBinary).isSymbolicLink() &&
  hasRequiredMacArchitectures(releaseBinary);
const inspectorReady = existsSync(inspectorBinary) && hasRequiredMacArchitectures(inspectorBinary);

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
    await $`swift build -c release --arch arm64 --arch x86_64`.cwd(nativeDir);
    console.log("[build-native] Built simbridge successfully.");
  } catch (error) {
    console.warn("[build-native] simbridge build failed:", error);
    process.exit(0);
  }
}

const builtBridge = findSwiftBuildOutput();

// Swift creates .build/release as a symlink. Flatten to a real dir for packaging.
if (existsSync(releaseDir) && lstatSync(releaseDir).isSymbolicLink()) {
  unlinkSync(releaseDir);
}

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

if (builtBridge && builtBridge !== releaseBinary) {
  copyFileSync(builtBridge, releaseBinary);
  chmodSync(releaseBinary, 0o755);
}

if (!existsSync(releaseBinary)) {
  console.warn("[build-native] simbridge build did not produce a release binary.");
  process.exit(1);
}

console.log(`[build-native] Binary ready: ${releaseBinary}`);

if (!inspectorReady) {
  console.log("[build-native] Building siminspector...");
  try {
    await $`bash ${inspectorBuildScript}`.cwd(nativeDir);
    console.log("[build-native] Built siminspector successfully.");
  } catch (error) {
    console.warn("[build-native] siminspector build failed:", error);
  }
}

if (!existsSync(inspectorBinary) || !hasRequiredMacArchitectures(inspectorBinary)) {
  console.warn("[build-native] siminspector build did not produce a universal dylib.");
  process.exit(1);
}

console.log(`[build-native] Dylib ready: ${inspectorBinary}`);
