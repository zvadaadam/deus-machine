#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const codexVersion = packageJson.dependencies["@openai/codex"];
const claudeSdkPackage = JSON.parse(
  readFileSync(
    join(projectRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
    "utf8"
  )
);
const claudeSdkVersion = claudeSdkPackage.version;
const claudeCodeVersion = claudeSdkPackage.claudeCodeVersion;

const cacheDir = join(projectRoot, "dist", "cache", "agent-clis");
const stagedBinRoot = join(projectRoot, "dist", "runtime", "electron", "bin");

const TARGETS = [
  {
    runtimeKey: "darwin-arm64",
    codexPackage: "@openai/codex",
    codexVersion: `${codexVersion}-darwin-arm64`,
    codexSource: "package/vendor/aarch64-apple-darwin/codex/codex",
    claudePackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    claudeVersion: claudeSdkVersion,
    claudeSource: "package/claude",
  },
  {
    runtimeKey: "darwin-x64",
    codexPackage: "@openai/codex",
    codexVersion: `${codexVersion}-darwin-x64`,
    codexSource: "package/vendor/x86_64-apple-darwin/codex/codex",
    claudePackage: "@anthropic-ai/claude-agent-sdk-darwin-x64",
    claudeVersion: claudeSdkVersion,
    claudeSource: "package/claude",
  },
];

function log(line) {
  console.log(`[agent-clis] ${line}`);
}

function registryPackageUrl(packageName, version) {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2F")}/${version}`;
}

function safeFileName(packageName, version) {
  return `${packageName.replaceAll("/", "__").replaceAll("@", "")}-${version}.tgz`;
}

function verifyIntegrity(buffer, integrity) {
  const [algorithm, expected] = integrity.split("-", 2);
  if (!algorithm || !expected) {
    throw new Error(`Unsupported npm integrity: ${integrity}`);
  }

  const actual = createHash(algorithm).update(buffer).digest("base64");
  if (actual !== expected) {
    throw new Error(`Integrity mismatch: expected ${expected}, got ${actual}`);
  }
}

async function downloadPackage(packageName, version) {
  const packageUrl = registryPackageUrl(packageName, version);
  const metadataResponse = await fetch(packageUrl, {
    headers: { "User-Agent": "deus-runtime-build" },
  });
  if (!metadataResponse.ok) {
    throw new Error(
      `Failed to fetch ${packageName}@${version}: ${metadataResponse.status} ${metadataResponse.statusText}`
    );
  }

  const metadata = await metadataResponse.json();
  const tarballUrl = metadata.dist?.tarball;
  const integrity = metadata.dist?.integrity;
  if (!tarballUrl || !integrity) {
    throw new Error(`${packageName}@${version} did not include tarball metadata`);
  }

  const archivePath = join(cacheDir, safeFileName(packageName, version));
  if (existsSync(archivePath)) return archivePath;

  log(`Downloading ${packageName}@${version}`);
  const archiveResponse = await fetch(tarballUrl, {
    headers: { "User-Agent": "deus-runtime-build" },
  });
  if (!archiveResponse.ok) {
    throw new Error(
      `Failed to download ${tarballUrl}: ${archiveResponse.status} ${archiveResponse.statusText}`
    );
  }

  const buffer = Buffer.from(await archiveResponse.arrayBuffer());
  verifyIntegrity(buffer, integrity);
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, buffer);
  return archivePath;
}

function clearMacExtendedAttributes(filePath) {
  if (process.platform !== "darwin") return;

  try {
    execFileSync("xattr", ["-c", filePath], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Non-fatal: signing/notarization will surface any real packaging issue.
  }
}

function getHostRuntimeKey() {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }

  return null;
}

function verifyRunnableBinary(filePath, runtimeKey, binaryName) {
  if (runtimeKey !== getHostRuntimeKey()) return;

  const version = execFileSync(filePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const expected =
    binaryName === "codex" ? `codex-cli ${codexVersion}` : `${claudeCodeVersion} (Claude Code)`;
  if (!version.includes(expected)) {
    throw new Error(`Unexpected ${binaryName} version for ${runtimeKey}: ${version}`);
  }
}

function stageBinary({ archivePath, runtimeKey, source, binaryName }) {
  const outputPath = join(stagedBinRoot, runtimeKey, binaryName);
  const tempDir = mkdtempSync(join(tmpdir(), `deus-${binaryName}-`));

  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", tempDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const sourcePath = join(tempDir, source);
    if (!existsSync(sourcePath)) {
      throw new Error(`${basename(archivePath)} did not contain ${source}`);
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(sourcePath, outputPath);
    chmodSync(outputPath, 0o755);
    clearMacExtendedAttributes(outputPath);
    verifyRunnableBinary(outputPath, runtimeKey, binaryName);
    log(`Staged ${binaryName} ${runtimeKey} -> ${outputPath}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!codexVersion) {
    throw new Error("package.json is missing @openai/codex");
  }
  if (!claudeSdkVersion || !claudeCodeVersion) {
    throw new Error("Could not read Claude Code version from @anthropic-ai/claude-agent-sdk");
  }

  for (const target of TARGETS) {
    const codexArchive = await downloadPackage(target.codexPackage, target.codexVersion);
    stageBinary({
      archivePath: codexArchive,
      runtimeKey: target.runtimeKey,
      source: target.codexSource,
      binaryName: "codex",
    });

    const claudeArchive = await downloadPackage(target.claudePackage, target.claudeVersion);
    stageBinary({
      archivePath: claudeArchive,
      runtimeKey: target.runtimeKey,
      source: target.claudeSource,
      binaryName: "claude",
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
