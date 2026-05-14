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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GH_VERSION = "2.92.0";
const GH_RELEASE_BASE_URL = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;
const VERIFY_TIMEOUT_MS = 20_000;

const TARGETS = [
  {
    runtimeKey: "darwin-x64",
    fileArch: "x86_64",
    archiveName: `gh_${GH_VERSION}_macOS_amd64.zip`,
    archiveRoot: `gh_${GH_VERSION}_macOS_amd64`,
    sha256: "ae9bb327ab0d91071bdada79f8f14034a2a0f19b0e001835a782eafa519d2af0",
  },
  {
    runtimeKey: "darwin-arm64",
    fileArch: "arm64",
    archiveName: `gh_${GH_VERSION}_macOS_arm64.zip`,
    archiveRoot: `gh_${GH_VERSION}_macOS_arm64`,
    sha256: "b11c54f6bd7d15ed6590475079e5b2fcf36f45d3991a80041b29c9d0cc1f1d07",
  },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const cacheDir = join(projectRoot, "dist", "cache", "gh", GH_VERSION);
const stagedBinRoot = join(projectRoot, "dist", "runtime", "electron", "bin");
const manifestPath = join(stagedBinRoot, "gh-cli.json");

function log(line) {
  console.log(`[gh-cli] ${line}`);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function relativeFromProjectRoot(filePath) {
  return filePath.startsWith(projectRoot)
    ? filePath.slice(projectRoot.length + 1).split("/").join("/")
    : filePath;
}

function clearMacExtendedAttributes(filePath) {
  if (process.platform !== "darwin") return;

  try {
    execFileSync("xattr", ["-c", filePath], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Non-fatal: signing/notarization will surface any real packaging issue.
  }
}

function verifyGhBinary(filePath, runtimeKey) {
  if (process.platform !== "darwin") return;
  execFileSync("codesign", ["--verify", "--verbose=2", filePath], {
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "pipe"],
  });
  log(`Verified ${runtimeKey} code signature`);
}

function inspectGhBinary(filePath, target) {
  const fileOutput = execFileSync("file", [filePath], {
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!fileOutput.includes("Mach-O 64-bit executable") || !fileOutput.includes(target.fileArch)) {
    throw new Error(`Unexpected gh architecture for ${target.runtimeKey}: ${fileOutput}`);
  }

  return {
    sha256: sha256(filePath),
    size: statSync(filePath).size,
    fileOutput,
  };
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
    execFileSync("unzip", ["-q", "-o", archivePath, "-d", tempDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const sourcePath = join(tempDir, target.archiveRoot, "bin", "gh");
    if (!existsSync(sourcePath)) {
      throw new Error(`Archive ${target.archiveName} did not contain ${target.archiveRoot}/bin/gh`);
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(sourcePath, outputPath);
    chmodSync(outputPath, 0o755);
    clearMacExtendedAttributes(outputPath);

    verifyGhBinary(outputPath, target.runtimeKey);
    const inspection = inspectGhBinary(outputPath, target);

    log(`Staged ${target.runtimeKey} -> ${outputPath}`);
    return {
      tool: "gh",
      runtimeKey: target.runtimeKey,
      path: relativeFromProjectRoot(outputPath),
      ...inspection,
      source: {
        version: GH_VERSION,
        archiveName: target.archiveName,
        archiveSha256: target.sha256,
        url: `${GH_RELEASE_BASE_URL}/${target.archiveName}`,
      },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const targets = [];
  for (const target of TARGETS) {
    const archivePath = await ensureArchive(target);
    targets.push(stageGhBinary(target, archivePath));
  }

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        ghVersion: GH_VERSION,
        targets,
      },
      null,
      2
    ) + "\n"
  );
  log(`Manifest written -> ${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
