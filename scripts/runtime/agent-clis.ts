import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeStagePaths } from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");
const VERIFY_TIMEOUT_MS = 20_000;

type AgentCliName = "codex" | "claude";

interface AgentCliTarget {
  runtimeKey: "darwin-arm64" | "darwin-x64";
  fileArch: "arm64" | "x86_64";
  codexAliasPackage: string;
  codexTriple: string;
  claudePackageName: string;
}

interface LockedPackage {
  lockKey: string;
  packageName: string;
  version: string;
  integrity: string;
}

interface StagedAgentCli {
  tool: AgentCliName | "rg";
  runtimeKey: string;
  path: string;
  sha256: string;
  size: number;
  fileOutput: string;
  source: {
    package: string;
    version: string;
    integrity: string;
    entry: string;
  };
  versionOutput?: string;
}

export interface AgentCliManifest {
  version: 1;
  generatedAt: string;
  targets: StagedAgentCli[];
}

export interface PrepareAgentCliOptions {
  log?: (line: string) => void;
  projectRoot?: string;
  verifyRunnable?: boolean;
}

export interface ValidateAgentCliOptions {
  log?: (line: string) => void;
  projectRoot?: string;
  runtimeKey?: string;
  verifyRunnable?: boolean;
}

export const AGENT_CLI_TARGETS: readonly AgentCliTarget[] = [
  {
    runtimeKey: "darwin-arm64",
    fileArch: "arm64",
    codexAliasPackage: "@openai/codex-darwin-arm64",
    codexTriple: "aarch64-apple-darwin",
    claudePackageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  },
  {
    runtimeKey: "darwin-x64",
    fileArch: "x86_64",
    codexAliasPackage: "@openai/codex-darwin-x64",
    codexTriple: "x86_64-apple-darwin",
    claudePackageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
  },
] as const;

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

export function resolveAgentCliManifestPath(projectRoot: string): string {
  return path.join(resolveRuntimeStagePaths(projectRoot).electron.root, "bin", "agent-clis.json");
}

export function resolveStagedAgentCliPath(
  projectRoot: string,
  runtimeKey: string,
  tool: AgentCliName | "rg"
): string {
  return path.join(resolveRuntimeStagePaths(projectRoot).electron.root, "bin", runtimeKey, tool);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePackageSpec(spec: string): { packageName: string; version: string } {
  const separator = spec.lastIndexOf("@");
  if (separator <= 0) {
    throw new Error(`Unexpected package spec in bun.lock: ${spec}`);
  }
  return {
    packageName: spec.slice(0, separator),
    version: spec.slice(separator + 1),
  };
}

function readLockedPackage(projectRoot: string, lockKey: string): LockedPackage {
  const lockPath = path.join(projectRoot, "bun.lock");
  const lockText = readFileSync(lockPath, "utf8");
  const entryPattern = new RegExp(
    `^\\s+"${escapeRegExp(lockKey)}": \\["([^"]+)".*"((?:sha\\d+-)[^"]+)"\\],?$`,
    "m"
  );
  const match = lockText.match(entryPattern);
  if (!match) {
    throw new Error(`Missing ${lockKey} in ${lockPath}`);
  }

  const parsed = parsePackageSpec(match[1]);
  return {
    lockKey,
    packageName: parsed.packageName,
    version: parsed.version,
    integrity: match[2],
  };
}

function nodeModulesPackagePath(projectRoot: string, packageName: string): string {
  const [scope, name] = packageName.split("/");
  if (!scope || !name) {
    return path.join(projectRoot, "node_modules", packageName);
  }
  return path.join(projectRoot, "node_modules", scope, name);
}

function packageTarballUrl(packageName: string, version: string): string {
  const packageBase = packageName.split("/").pop();
  if (!packageBase) throw new Error(`Invalid package name: ${packageName}`);
  return `https://registry.npmjs.org/${packageName}/-/${packageBase}-${version}.tgz`;
}

function verifyIntegrity(buffer: Buffer, integrity: string, url: string): void {
  const [algorithm, expected] = integrity.split("-");
  if (!algorithm || !expected) {
    throw new Error(`Unsupported integrity string for ${url}: ${integrity}`);
  }

  const actual = createHash(algorithm).update(buffer).digest("base64");
  if (actual !== expected) {
    throw new Error(`Integrity mismatch for ${url}: expected ${integrity}`);
  }
}

function fetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        fetchBuffer(response.headers.location).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GET ${url} failed with HTTP ${response.statusCode}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function extractPackageArtifact(
  lockedPackage: LockedPackage,
  log: (line: string) => void
): Promise<{ packageRoot: string; cleanup: () => void; sourceDescription: string }> {
  const url = packageTarballUrl(lockedPackage.packageName, lockedPackage.version);
  log(`Downloading ${lockedPackage.packageName}@${lockedPackage.version}`);
  const tarball = await fetchBuffer(url);
  verifyIntegrity(tarball, lockedPackage.integrity, url);

  const tempRoot = mkdtempSync(path.join(tmpdir(), "deus-agent-cli-"));
  const tarballPath = path.join(tempRoot, "package.tgz");
  writeFileSync(tarballPath, tarball);
  execFileSync("tar", ["-xzf", tarballPath, "-C", tempRoot], { stdio: "pipe" });

  return {
    packageRoot: path.join(tempRoot, "package"),
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
    sourceDescription: url,
  };
}

async function resolvePackageRoot(
  projectRoot: string,
  lockedPackage: LockedPackage,
  expectedEntry: string,
  log: (line: string) => void
): Promise<{ packageRoot: string; cleanup: () => void; sourceDescription: string }> {
  const installedPackageRoot = nodeModulesPackagePath(projectRoot, lockedPackage.lockKey);
  if (existsSync(path.join(installedPackageRoot, expectedEntry))) {
    return {
      packageRoot: installedPackageRoot,
      cleanup: () => undefined,
      sourceDescription: relativeFromProjectRoot(projectRoot, installedPackageRoot),
    };
  }

  return extractPackageArtifact(lockedPackage, log);
}

function copyExecutable(source: string, destination: string): void {
  if (!existsSync(source)) {
    throw new Error(`Missing source executable: ${source}`);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination) && filesMatch(source, destination)) {
    chmodSync(destination, 0o755);
    return;
  }
  rmSync(destination, { force: true });
  try {
    linkSync(source, destination);
  } catch {
    cpSync(source, destination);
  }
  chmodSync(destination, 0o755);
}

function filesMatch(left: string, right: string): boolean {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  if (leftStat.size !== rightStat.size) return false;
  return hashFile(left) === hashFile(right);
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function shouldVerifyRuntimeKey(runtimeKey: string): boolean {
  if (process.platform !== "darwin") return false;
  return runtimeKey === `darwin-${process.arch}`;
}

function verifyVersion(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  return execFileSync(executablePath, args, {
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertVersionOutput(tool: AgentCliName, output: string, executablePath: string): void {
  if (!output) {
    throw new Error(`${tool} --version produced no output for ${executablePath}`);
  }
  if (tool === "codex" && !/\b\d+\.\d+\.\d+\b/.test(output)) {
    throw new Error(`Unexpected codex --version output for ${executablePath}: ${output}`);
  }
  if (tool === "claude" && !/Claude Code|\b\d+\.\d+\.\d+\b/.test(output)) {
    throw new Error(`Unexpected claude --version output for ${executablePath}: ${output}`);
  }
}

export function verifyStagedAgentCliVersion(
  tool: AgentCliName,
  executablePath: string
): string {
  const binDir = path.dirname(executablePath);
  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const output = verifyVersion(
    executablePath,
    [tool === "claude" ? "--version" : "--version"],
    env
  );
  assertVersionOutput(tool, output, executablePath);
  return output;
}

function inspectStaticExecutable(
  filePath: string,
  label: string,
  fileArch: string
): { sha256: string; size: number; fileOutput: string } {
  assertExecutable(filePath, label);
  return {
    sha256: hashFile(filePath),
    size: statSync(filePath).size,
    fileOutput: getMachOArchOutput(filePath, label, fileArch),
  };
}

function assertManifestEntry(
  projectRoot: string,
  manifestEntries: StagedAgentCli[],
  runtimeKey: string,
  tool: AgentCliName | "rg",
  executablePath: string,
  inspection: { sha256: string; size: number; fileOutput: string }
): void {
  const entry = manifestEntries.find((candidate) => candidate.tool === tool);
  if (!entry) {
    throw new Error(`Agent CLI manifest is missing ${runtimeKey}/${tool}`);
  }

  const expectedPath = relativeFromProjectRoot(projectRoot, executablePath);
  if (entry.path !== expectedPath) {
    throw new Error(
      `Agent CLI manifest path mismatch for ${runtimeKey}/${tool}: expected ${expectedPath}, found ${entry.path}`
    );
  }
  if (entry.sha256 !== inspection.sha256) {
    throw new Error(`Agent CLI manifest hash mismatch for ${runtimeKey}/${tool}`);
  }
  if (entry.size !== inspection.size) {
    throw new Error(`Agent CLI manifest size mismatch for ${runtimeKey}/${tool}`);
  }
  if (entry.fileOutput !== inspection.fileOutput) {
    throw new Error(`Agent CLI manifest file output mismatch for ${runtimeKey}/${tool}`);
  }
}

export async function prepareAgentClis(
  options: PrepareAgentCliOptions = {}
): Promise<AgentCliManifest> {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const verifyRunnable = options.verifyRunnable === true;
  const manifestTargets: StagedAgentCli[] = [];

  for (const target of AGENT_CLI_TARGETS) {
    const targetDir = path.dirname(
      resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "codex")
    );
    mkdirSync(targetDir, { recursive: true });

    const lockedCodex = readLockedPackage(projectRoot, target.codexAliasPackage);
    const codexEntry = path.join("vendor", target.codexTriple, "codex", "codex");
    const rgEntry = path.join("vendor", target.codexTriple, "path", "rg");
    const codexPackage = await resolvePackageRoot(projectRoot, lockedCodex, codexEntry, log);
    try {
      const stagedCodex = resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "codex");
      const stagedRg = resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "rg");
      copyExecutable(path.join(codexPackage.packageRoot, codexEntry), stagedCodex);
      copyExecutable(path.join(codexPackage.packageRoot, rgEntry), stagedRg);
      const codexInspection = inspectStaticExecutable(
        stagedCodex,
        `${target.runtimeKey}/codex`,
        target.fileArch
      );
      const rgInspection = inspectStaticExecutable(
        stagedRg,
        `${target.runtimeKey}/rg`,
        target.fileArch
      );

      const codexRecord: StagedAgentCli = {
        tool: "codex",
        runtimeKey: target.runtimeKey,
        path: relativeFromProjectRoot(projectRoot, stagedCodex),
        ...codexInspection,
        source: {
          package: lockedCodex.packageName,
          version: lockedCodex.version,
          integrity: lockedCodex.integrity,
          entry: codexEntry.split(path.sep).join("/"),
        },
      };

      if (verifyRunnable && shouldVerifyRuntimeKey(target.runtimeKey)) {
        codexRecord.versionOutput = verifyStagedAgentCliVersion("codex", stagedCodex);
        log(`✓ ${target.runtimeKey}/codex ${codexRecord.versionOutput}`);
      } else {
        log(`✓ ${target.runtimeKey}/codex staged from ${codexPackage.sourceDescription}`);
      }
      manifestTargets.push(codexRecord);
      manifestTargets.push({
        tool: "rg",
        runtimeKey: target.runtimeKey,
        path: relativeFromProjectRoot(projectRoot, stagedRg),
        ...rgInspection,
        source: {
          package: lockedCodex.packageName,
          version: lockedCodex.version,
          integrity: lockedCodex.integrity,
          entry: rgEntry.split(path.sep).join("/"),
        },
      });
    } finally {
      codexPackage.cleanup();
    }

    const lockedClaude = readLockedPackage(projectRoot, target.claudePackageName);
    const claudePackage = await resolvePackageRoot(projectRoot, lockedClaude, "claude", log);
    try {
      const stagedClaude = resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "claude");
      copyExecutable(path.join(claudePackage.packageRoot, "claude"), stagedClaude);
      const claudeInspection = inspectStaticExecutable(
        stagedClaude,
        `${target.runtimeKey}/claude`,
        target.fileArch
      );

      const claudeRecord: StagedAgentCli = {
        tool: "claude",
        runtimeKey: target.runtimeKey,
        path: relativeFromProjectRoot(projectRoot, stagedClaude),
        ...claudeInspection,
        source: {
          package: lockedClaude.packageName,
          version: lockedClaude.version,
          integrity: lockedClaude.integrity,
          entry: "claude",
        },
      };

      if (verifyRunnable && shouldVerifyRuntimeKey(target.runtimeKey)) {
        claudeRecord.versionOutput = verifyStagedAgentCliVersion("claude", stagedClaude);
        log(`✓ ${target.runtimeKey}/claude ${claudeRecord.versionOutput}`);
      } else {
        log(`✓ ${target.runtimeKey}/claude staged from ${claudePackage.sourceDescription}`);
      }
      manifestTargets.push(claudeRecord);
    } finally {
      claudePackage.cleanup();
    }
  }

  const manifest: AgentCliManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    targets: manifestTargets,
  };
  const manifestPath = resolveAgentCliManifestPath(projectRoot);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  log(`✓ Agent CLIs staged at ${relativeFromProjectRoot(projectRoot, path.dirname(manifestPath))}`);
  return manifest;
}

function assertExecutable(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Expected ${label} to be a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`Expected ${label} to be executable: ${filePath}`);
  }
}

function getMachOArchOutput(filePath: string, label: string, fileArch: string): string {
  const fileOutput = execFileSync("file", [filePath], {
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!fileOutput.includes("Mach-O 64-bit executable") || !fileOutput.includes(fileArch)) {
    throw new Error(`Unexpected ${label} architecture: ${fileOutput}`);
  }
  return fileOutput;
}

export function validateStagedAgentClis(
  options: ValidateAgentCliOptions = {}
): AgentCliManifest {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const manifestPath = resolveAgentCliManifestPath(projectRoot);
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing staged agent CLI manifest: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AgentCliManifest;
  const runtimeKeys = options.runtimeKey
    ? [options.runtimeKey]
    : AGENT_CLI_TARGETS.map((target) => target.runtimeKey);

  for (const runtimeKey of runtimeKeys) {
    const target = AGENT_CLI_TARGETS.find((item) => item.runtimeKey === runtimeKey);
    if (!target) throw new Error(`Unsupported agent CLI runtime key: ${runtimeKey}`);
    const manifestEntries = manifest.targets.filter((entry) => entry.runtimeKey === runtimeKey);

    for (const tool of ["codex", "claude", "rg"] as const) {
      const executablePath = resolveStagedAgentCliPath(projectRoot, runtimeKey, tool);
      const inspection = inspectStaticExecutable(
        executablePath,
        `${runtimeKey}/${tool}`,
        target.fileArch
      );
      assertManifestEntry(
        projectRoot,
        manifestEntries,
        runtimeKey,
        tool,
        executablePath,
        inspection
      );
    }

    if (manifestEntries.length !== 3) {
      throw new Error(
        `Agent CLI manifest expected 3 entries for ${runtimeKey}, found ${manifestEntries.length}`
      );
    }

    if (options.verifyRunnable === true && shouldVerifyRuntimeKey(runtimeKey)) {
      for (const tool of ["codex", "claude"] as const) {
        const executablePath = resolveStagedAgentCliPath(projectRoot, runtimeKey, tool);
        const version = verifyStagedAgentCliVersion(tool, executablePath);
        log(`✓ ${runtimeKey}/${tool} ${version}`);
      }
    }
  }

  log(`✓ Staged agent CLIs ready (${runtimeKeys.join(", ")})`);
  return manifest;
}
