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
import type { RuntimeManifest } from "./stage";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");
const BUILD_RUNTIME_COMMAND = "bun run build:runtime";

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

function assertExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw createBuildRuntimeError(`Missing ${label}: ${filePath}`);
  }
}

function assertExecutable(filePath: string, label: string): void {
  assertExists(filePath, label);
  if ((statSync(filePath).mode & 0o111) === 0) {
    throw createBuildRuntimeError(`Expected ${label} to be executable: ${filePath}`);
  }
}

function getCodexTargetTriple(): string | null {
  if (process.platform === "linux") {
    if (process.arch === "x64") return "x86_64-unknown-linux-musl";
    if (process.arch === "arm64") return "aarch64-unknown-linux-musl";
  }
  if (process.platform === "darwin") {
    if (process.arch === "x64") return "x86_64-apple-darwin";
    if (process.arch === "arm64") return "aarch64-apple-darwin";
  }
  return null;
}

function getCodexPlatformPackageName(): string | null {
  if (process.platform === "linux") return `@openai/codex-linux-${process.arch}`;
  if (process.platform === "darwin") return `@openai/codex-darwin-${process.arch}`;
  return null;
}

function getClaudePlatformPackageNames(): string[] {
  if (process.platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
    ];
  }
  if (process.platform === "darwin") {
    return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];
  }
  return [];
}

function assertPackagedProviderBinaries(projectRoot: string): void {
  const nodeModulesDir = path.join(projectRoot, "node_modules");
  const claudeCandidate = getClaudePlatformPackageNames()
    .map((packageName) => path.join(nodeModulesDir, packageName, "claude"))
    .find((candidate) => existsSync(candidate));

  if (!claudeCandidate) {
    throw createBuildRuntimeError(
      `Missing packaged Claude executable for ${process.platform}-${process.arch}`
    );
  }
  assertExecutable(claudeCandidate, "packaged Claude executable");

  const codexPackageName = getCodexPlatformPackageName();
  const codexTargetTriple = getCodexTargetTriple();
  if (!codexPackageName || !codexTargetTriple) {
    throw createBuildRuntimeError(
      `Unsupported packaged Codex platform: ${process.platform}-${process.arch}`
    );
  }

  const codexExecutable = path.join(
    nodeModulesDir,
    codexPackageName,
    "vendor",
    codexTargetTriple,
    "codex",
    "codex"
  );
  assertExecutable(codexExecutable, "packaged Codex executable");
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
      electron: {
        backend: relativeFromProjectRoot(projectRoot, stagePaths.electron.backendBundle),
        agentServer: relativeFromProjectRoot(projectRoot, stagePaths.electron.agentServerBundle),
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
  assertExists(stagePaths.electron.backendBundle, "staged electron backend bundle");
  assertExists(stagePaths.electron.agentServerBundle, "staged electron agent-server bundle");

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
    stagePaths.electron.backendBundle,
    "staged electron backend bundle",
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
  assertNotStale(
    projectRoot,
    stagePaths.electron.agentServerBundle,
    "staged electron agent-server bundle",
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
