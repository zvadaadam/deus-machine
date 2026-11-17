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
const ghContract = JSON.parse(
  readFileSync(join(scriptDir, "runtime", "gh-cli-contract.json"), "utf8")
);
const GH_VERSION = ghContract.ghVersion;
const GH_RELEASE_BASE_URL = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;
const TARGETS = ghContract.targets.map((target) => ({
  ...target,
  archiveExtension: target.archiveExtension || "zip",
  archiveName: `gh_${GH_VERSION}_${target.archivePlatform}.${target.archiveExtension || "zip"}`,
  archiveRoot: `gh_${GH_VERSION}_${target.archivePlatform}`,
  sha256: target.archiveSha256,
}));
const cacheDir = join(projectRoot, "dist", "cache", "gh", GH_VERSION);
const stagedBinRoot = join(projectRoot, "dist", "runtime", "electron", "bin");

function log(line) {
  console.log(`[gh-cli] ${line}`);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function clearMacExtendedAttributes(filePath) {
  if (process.platform !== "darwin") return;

  try {
    execFileSync("xattr", ["-c", filePath], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Non-fatal: signing/notarization will surface any real packaging issue.
  }
}

async function downloadFile(url, destinationPath) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "deus-runtime-build",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, buffer);
}

async function ensureArchive(target) {
  const archivePath = join(cacheDir, target.archiveName);
  if (existsSync(archivePath) && sha256(archivePath) === target.sha256) {
    return archivePath;
  }

  if (existsSync(archivePath)) {
    rmSync(archivePath, { force: true });
  }

  const url = `${GH_RELEASE_BASE_URL}/${target.archiveName}`;
  log(`Downloading ${basename(archivePath)}`);
  await downloadFile(url, archivePath);

  const actualSha = sha256(archivePath);
  if (actualSha !== target.sha256) {
    rmSync(archivePath, { force: true });
    throw new Error(
      `Checksum mismatch for ${target.archiveName}: expected ${target.sha256}, got ${actualSha}`
    );
  }

  return archivePath;
}

function stageGhBinary(target, archivePath) {
  const outputPath = join(stagedBinRoot, target.runtimeKey, "gh");

  const tempDir = mkdtempSync(join(tmpdir(), "deus-gh-"));
  try {
    if (target.archiveExtension === "zip") {
      execFileSync("unzip", ["-q", "-o", archivePath, "-d", tempDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else if (target.archiveExtension === "tar.gz") {
      execFileSync("tar", ["-xzf", archivePath, "-C", tempDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      throw new Error(`Unsupported gh archive extension: ${target.archiveExtension}`);
    }

    const sourcePath = join(tempDir, target.archiveRoot, "bin", "gh");
    if (!existsSync(sourcePath)) {
      throw new Error(`Archive ${target.archiveName} did not contain ${target.archiveRoot}/bin/gh`);
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(sourcePath, outputPath);
    chmodSync(outputPath, 0o755);
    clearMacExtendedAttributes(outputPath);
    log(`Staged ${target.runtimeKey} -> ${outputPath}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  for (const target of TARGETS) {
    stageGhBinary(target, await ensureArchive(target));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
