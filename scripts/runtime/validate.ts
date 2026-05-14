import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_RUNTIME_DEPENDENCIES,
  DEUS_APP_ID,
  DEUS_DB_FILENAME,
  DEUS_PREFERENCES_FILENAME,
  RUNTIME_MANIFEST_VERSION,
  resolveRuntimeStagePaths,
} from "../../shared/runtime";
import { validateStagedAgentClis } from "./agent-clis";
import { validateDeusRuntime } from "./native-runtime";
import type { RuntimeManifest } from "./stage";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");
const BUILD_RUNTIME_COMMAND = "bun run build:runtime";
const DARWIN_NATIVE_CLI_TARGETS = [
  { runtimeKey: "darwin-arm64", fileArch: "arm64" },
  { runtimeKey: "darwin-x64", fileArch: "x86_64" },
] as const;

interface GhCliManifest {
  version: 1;
  ghVersion: string;
  targets: Array<{
    tool: "gh";
    runtimeKey: string;
    path: string;
    sha256: string;
    size: number;
    fileOutput: string;
  }>;
}

export interface ValidateRuntimeStageOptions {
  log?: (line: string) => void;
  projectRoot?: string;
}

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

function createBuildRuntimeError(message: string): Error {
  return new Error(`${message}\nRun \`${BUILD_RUNTIME_COMMAND}\` before packaging.`);
}

function readManifest(manifestPath: string): RuntimeManifest {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
  } catch (error) {
    throw createBuildRuntimeError(
      `Unable to read staged runtime manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw createBuildRuntimeError(`Missing ${label}: ${filePath}`);
  }
}

function assertExecutable(filePath: string, label: string): void {
  assertExists(filePath, label);
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw createBuildRuntimeError(`Expected ${label} to be a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw createBuildRuntimeError(`Expected ${label} to be executable: ${filePath}`);
  }
}

function getMachOArchOutput(filePath: string, label: string, fileArch: string): string {
  const fileOutput = execFileSync("file", [filePath], {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!fileOutput.includes("Mach-O 64-bit executable") || !fileOutput.includes(fileArch)) {
    throw createBuildRuntimeError(`Unexpected ${label} architecture: ${fileOutput}`);
  }
  return fileOutput;
}

function verifyMacCodeSignature(filePath: string, label: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("codesign", ["--verify", "--verbose=2", filePath], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw createBuildRuntimeError(
      `Invalid ${label} code signature: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function assertStagedGhCli(projectRoot: string): void {
  const binRoot = path.join(resolveRuntimeStagePaths(projectRoot).electron.root, "bin");
  const manifestPath = path.join(binRoot, "gh-cli.json");
  assertExists(manifestPath, "staged GitHub CLI manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GhCliManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.targets)) {
    throw createBuildRuntimeError(`Unexpected staged GitHub CLI manifest shape: ${manifestPath}`);
  }

  for (const target of DARWIN_NATIVE_CLI_TARGETS) {
    const ghPath = path.join(binRoot, target.runtimeKey, "gh");
    const label = `${target.runtimeKey}/gh`;
    assertExecutable(ghPath, label);
    const fileOutput = getMachOArchOutput(ghPath, label, target.fileArch);
    verifyMacCodeSignature(ghPath, label);
    const manifestEntry = manifest.targets.find(
      (entry) => entry.runtimeKey === target.runtimeKey && entry.tool === "gh"
    );
    if (!manifestEntry) {
      throw createBuildRuntimeError(`GitHub CLI manifest is missing ${target.runtimeKey}/gh`);
    }
    const expectedPath = relativeFromProjectRoot(projectRoot, ghPath);
    if (manifestEntry.path !== expectedPath) {
      throw createBuildRuntimeError(
        `GitHub CLI manifest path mismatch for ${target.runtimeKey}/gh: expected ${expectedPath}, found ${manifestEntry.path}`
      );
    }
    if (manifestEntry.sha256 !== hashFile(ghPath)) {
      throw createBuildRuntimeError(`GitHub CLI manifest hash mismatch for ${target.runtimeKey}/gh`);
    }
    if (manifestEntry.size !== statSync(ghPath).size) {
      throw createBuildRuntimeError(`GitHub CLI manifest size mismatch for ${target.runtimeKey}/gh`);
    }
    if (manifestEntry.fileOutput !== fileOutput) {
      throw createBuildRuntimeError(
        `GitHub CLI manifest file output mismatch for ${target.runtimeKey}/gh`
      );
    }
  }
}

function assertPackagedProviderBinaries(projectRoot: string): void {
  try {
    validateDeusRuntime({
      projectRoot,
      log: () => undefined,
      verifyRunnable: process.env.DEUS_VERIFY_RUNTIME_RUNNABLE === "1",
    });
  } catch (error) {
    throw createBuildRuntimeError(
      `Native runtime validation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    validateStagedAgentClis({ projectRoot, log: () => undefined, verifyRunnable: false });
  } catch (error) {
    throw createBuildRuntimeError(
      `Staged agent CLI validation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  assertStagedGhCli(projectRoot);
}

function assertNotStale(
  projectRoot: string,
  filePath: string,
  label: string,
  sourcePath: string,
  sourceLabel: string
): void {
  if (statSync(filePath).mtimeMs < statSync(sourcePath).mtimeMs) {
    throw createBuildRuntimeError(
      `${label} is stale: ${relativeFromProjectRoot(projectRoot, filePath)} is older than ${relativeFromProjectRoot(projectRoot, sourcePath)} (${sourceLabel})`
    );
  }
}

function buildExpectedManifest(projectRoot: string): RuntimeManifest {
  const stagePaths = resolveRuntimeStagePaths(projectRoot);
  return {
    version: RUNTIME_MANIFEST_VERSION,
    appId: DEUS_APP_ID,
    data: {
      databaseFile: DEUS_DB_FILENAME,
      preferencesFile: DEUS_PREFERENCES_FILENAME,
    },
    bundles: {
      common: {
        backend: relativeFromProjectRoot(projectRoot, stagePaths.common.backendBundle),
        agentServer: relativeFromProjectRoot(projectRoot, stagePaths.common.agentServerBundle),
      },
    },
    nodeRuntimeDependencies: CLI_RUNTIME_DEPENDENCIES,
  };
}

export function validateRuntimeStage(options: ValidateRuntimeStageOptions = {}): RuntimeManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const stagePaths = resolveRuntimeStagePaths(projectRoot);
  const sources = {
    backendBundle: path.join(projectRoot, "apps", "backend", "dist", "server.bundled.cjs"),
    agentServerBundle: path.join(projectRoot, "apps", "agent-server", "dist", "index.bundled.cjs"),
  };

  assertExists(sources.backendBundle, "runtime source bundle (backend)");
  assertExists(sources.agentServerBundle, "runtime source bundle (agent-server)");
  assertExists(stagePaths.manifest, "staged runtime manifest");
  assertExists(stagePaths.common.backendBundle, "staged common backend bundle");
  assertExists(stagePaths.common.agentServerBundle, "staged common agent-server bundle");

  const manifest = readManifest(stagePaths.manifest);
  const expectedManifest = buildExpectedManifest(projectRoot);
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw createBuildRuntimeError(
      `Staged runtime manifest at ${stagePaths.manifest} does not match the current runtime contract`
    );
  }

  assertNotStale(
    projectRoot,
    stagePaths.common.backendBundle,
    "staged common backend bundle",
    sources.backendBundle,
    "backend source bundle"
  );
  assertNotStale(
    projectRoot,
    stagePaths.common.agentServerBundle,
    "staged common agent-server bundle",
    sources.agentServerBundle,
    "agent-server source bundle"
  );
  const latestSourceMtime = Math.max(
    statSync(sources.backendBundle).mtimeMs,
    statSync(sources.agentServerBundle).mtimeMs
  );
  if (statSync(stagePaths.manifest).mtimeMs < latestSourceMtime) {
    throw createBuildRuntimeError(
      `Staged runtime manifest is stale: ${relativeFromProjectRoot(projectRoot, stagePaths.manifest)} is older than the source bundles`
    );
  }

  assertPackagedProviderBinaries(projectRoot);

  log(
    `✓ Staged runtime ready for packaging (${relativeFromProjectRoot(projectRoot, stagePaths.root)})`
  );
  return manifest;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    validateRuntimeStage();
  } catch (error) {
    console.error("Runtime validation failed:", error);
    process.exit(1);
  }
}
