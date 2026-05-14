import { execFileSync, spawn, spawnSync } from "node:child_process";
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
const VERIFY_STOP_TIMEOUT_MS = 5_000;
// Keep in sync with apps/agent-server/agents/codex-server/codex-server-discovery.ts.
const MIN_CODEX_APP_SERVER_VERSION = "0.128.0";
const VERSION_CHECK_ENV_DENYLIST = [
  "AGENT_SERVER_CWD",
  "AGENT_SERVER_ENTRY",
  "AUTH_TOKEN",
  "BUN_OPTIONS",
  "DATABASE_PATH",
  "DEUS_AUTH_TOKEN",
  "DEUS_BACKEND_PORT",
  "DEUS_BUNDLED_BIN_DIR",
  "DEUS_DATA_DIR",
  "DEUS_PACKAGED",
  "DEUS_RESOURCES_PATH",
  "DEUS_RUNTIME",
  "DEUS_RUNTIME_COMMAND",
  "DEUS_RUNTIME_EXECUTABLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "PORT",
] as const;

type AgentCliName = "codex" | "claude";
type BundledAgentToolName = AgentCliName | "rg" | "agent-browser";

interface AgentCliTarget {
  runtimeKey: "darwin-arm64" | "darwin-x64";
  fileArch: "arm64" | "x86_64";
  agentBrowserEntry: "bin/agent-browser-darwin-arm64" | "bin/agent-browser-darwin-x64";
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
  tool: BundledAgentToolName;
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
    agentBrowserEntry: "bin/agent-browser-darwin-arm64",
    codexAliasPackage: "@openai/codex-darwin-arm64",
    codexTriple: "aarch64-apple-darwin",
    claudePackageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  },
  {
    runtimeKey: "darwin-x64",
    fileArch: "x86_64",
    agentBrowserEntry: "bin/agent-browser-darwin-x64",
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
  tool: BundledAgentToolName
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

function readSemver(version: string): string | null {
  return version.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function isVersionAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const currentParts = version.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);

  for (let i = 0; i < minimumParts.length; i++) {
    const current = currentParts[i] ?? 0;
    const required = minimumParts[i] ?? 0;
    if (current > required) return true;
    if (current < required) return false;
  }
  return true;
}

function assertCodexAppServerCompatible(version: string, label: string): void {
  const semver = readSemver(version);
  if (isVersionAtLeast(semver, MIN_CODEX_APP_SERVER_VERSION)) return;

  throw new Error(
    `${label} requires @openai/codex >= ${MIN_CODEX_APP_SERVER_VERSION} for the codex app-server harness; found ${version}`
  );
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

function spawnErrorCode(error: Error | undefined): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? error?.message ?? "none";
}

function verifyVersion(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const result = spawnSync(executablePath, args, {
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = (result.stdout || "").trim();
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const diagnostics = stagedExecutableDiagnostics(executablePath);
    const hint = macExecutionPolicyHint(diagnostics);
    throw new Error(
      `${path.basename(executablePath)} ${args.join(" ")} failed: status=${result.status} signal=${
        result.signal
      } error=${spawnErrorCode(result.error)} stdout=${output} stderr=${stderr}${
        diagnostics ? `\n${diagnostics}` : ""
      }${hint}`
    );
  }
  return output;
}

function killChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if process-group termination is unavailable.
    }
  }
  child.kill(signal);
}

function stopVersionChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killChildTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      finish();
    }, VERIFY_STOP_TIMEOUT_MS);
    child.once("exit", finish);
    killChildTree(child, "SIGTERM");
  });
}

async function verifyVersionBounded(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const child = spawn(executablePath, args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        const diagnostics = stagedExecutableDiagnostics(executablePath);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `${path.basename(executablePath)} ${args.join(
              " "
            )} timed out after ${VERIFY_TIMEOUT_MS}ms stdout=${stdout
              .trim()
              .slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      }, VERIFY_TIMEOUT_MS);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        const diagnostics = stagedExecutableDiagnostics(executablePath);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `${path.basename(executablePath)} ${args.join(" ")} failed to spawn: error=${spawnErrorCode(
              error
            )} stdout=${stdout.trim().slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        if (code === 0) {
          settled = true;
          clearTimeout(timeout);
          resolve();
          return;
        }

        const diagnostics = stagedExecutableDiagnostics(executablePath);
        const hint = macExecutionPolicyHint(diagnostics);
        fail(
          new Error(
            `${path.basename(executablePath)} ${args.join(" ")} failed: status=${code} signal=${
              signal ?? "none"
            } stdout=${stdout.trim().slice(-4000)} stderr=${stderr.trim().slice(-4000)}${
              diagnostics ? `\n${diagnostics}` : ""
            }${hint}`
          )
        );
      });
    });
  } finally {
    await stopVersionChild(child);
  }

  return stdout.trim();
}

function diagnosticOutput(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) {
    return [spawnErrorCode(result.error), output].filter(Boolean).join("\n");
  }
  if (result.status !== 0) return output || `${command} exited with status ${result.status}`;
  return output;
}

function stagedExecutableDiagnostics(executablePath: string): string {
  if (process.platform !== "darwin") return "";
  const cwd = path.dirname(executablePath);
  return [
    `file: ${diagnosticOutput("file", [executablePath], cwd)}`,
    `codesign: ${diagnosticOutput("codesign", ["-dv", "--verbose=4", executablePath], cwd)}`,
    `spctl: ${diagnosticOutput("spctl", ["--assess", "--type", "execute", "--verbose=4", executablePath], cwd)}`,
    `xattr: ${diagnosticOutput("xattr", ["-l", executablePath], cwd) || "none"}`,
  ].join("\n");
}

function macExecutionPolicyHint(diagnostics: string): string {
  if (process.platform !== "darwin") return "";
  if (!/spctl:[\s\S]*rejected/.test(diagnostics)) return "";
  if (!/com\.apple\.(provenance|quarantine)/.test(diagnostics)) return "";

  return [
    "",
    "macOS rejected this executable before --version produced output.",
    "Verify runnable staged agent CLIs on a notarized artifact or a macOS host that allows generated/copied Mach-O binaries to launch.",
  ].join("\n");
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

export function verifyStagedAgentCliVersion(tool: AgentCliName, executablePath: string): string {
  const binDir = path.dirname(executablePath);
  const env = versionCheckEnv(binDir);
  const output = verifyVersion(
    executablePath,
    [tool === "claude" ? "--version" : "--version"],
    env
  );
  assertVersionOutput(tool, output, executablePath);
  return output;
}

async function verifyStagedAgentCliVersionBounded(
  tool: AgentCliName,
  executablePath: string
): Promise<string> {
  const binDir = path.dirname(executablePath);
  const env = versionCheckEnv(binDir);
  const output = await verifyVersionBounded(executablePath, ["--version"], env);
  assertVersionOutput(tool, output, executablePath);
  return output;
}

function versionCheckEnv(binDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VERSION_CHECK_ENV_DENYLIST) {
    delete env[key];
  }
  env.PATH = [binDir, process.env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

function inspectStaticExecutable(
  projectRoot: string,
  filePath: string,
  label: string,
  fileArch: string
): { sha256: string; size: number; fileOutput: string } {
  assertExecutable(filePath, label);
  return {
    sha256: hashFile(filePath),
    size: statSync(filePath).size,
    fileOutput: getMachOArchOutput(projectRoot, filePath, label, fileArch),
  };
}

function assertManifestEntry(
  projectRoot: string,
  manifestEntries: StagedAgentCli[],
  runtimeKey: string,
  tool: BundledAgentToolName,
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
    assertCodexAppServerCompatible(lockedCodex.version, target.runtimeKey);
    const codexEntry = path.join("vendor", target.codexTriple, "codex", "codex");
    const rgEntry = path.join("vendor", target.codexTriple, "path", "rg");
    const codexPackage = await resolvePackageRoot(projectRoot, lockedCodex, codexEntry, log);
    try {
      const stagedCodex = resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "codex");
      const stagedRg = resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "rg");
      copyExecutable(path.join(codexPackage.packageRoot, codexEntry), stagedCodex);
      copyExecutable(path.join(codexPackage.packageRoot, rgEntry), stagedRg);
      const codexInspection = inspectStaticExecutable(
        projectRoot,
        stagedCodex,
        `${target.runtimeKey}/codex`,
        target.fileArch
      );
      const rgInspection = inspectStaticExecutable(
        projectRoot,
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
        codexRecord.versionOutput = await verifyStagedAgentCliVersionBounded("codex", stagedCodex);
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
        projectRoot,
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
        claudeRecord.versionOutput = await verifyStagedAgentCliVersionBounded(
          "claude",
          stagedClaude
        );
        log(`✓ ${target.runtimeKey}/claude ${claudeRecord.versionOutput}`);
      } else {
        log(`✓ ${target.runtimeKey}/claude staged from ${claudePackage.sourceDescription}`);
      }
      manifestTargets.push(claudeRecord);
    } finally {
      claudePackage.cleanup();
    }

    const lockedAgentBrowser = readLockedPackage(projectRoot, "agent-browser");
    const agentBrowserPackage = await resolvePackageRoot(
      projectRoot,
      lockedAgentBrowser,
      target.agentBrowserEntry,
      log
    );
    try {
      const stagedAgentBrowser = resolveStagedAgentCliPath(
        projectRoot,
        target.runtimeKey,
        "agent-browser"
      );
      copyExecutable(
        path.join(agentBrowserPackage.packageRoot, target.agentBrowserEntry),
        stagedAgentBrowser
      );
      const agentBrowserInspection = inspectStaticExecutable(
        projectRoot,
        stagedAgentBrowser,
        `${target.runtimeKey}/agent-browser`,
        target.fileArch
      );

      manifestTargets.push({
        tool: "agent-browser",
        runtimeKey: target.runtimeKey,
        path: relativeFromProjectRoot(projectRoot, stagedAgentBrowser),
        ...agentBrowserInspection,
        source: {
          package: lockedAgentBrowser.packageName,
          version: lockedAgentBrowser.version,
          integrity: lockedAgentBrowser.integrity,
          entry: target.agentBrowserEntry,
        },
      });
      log(
        `✓ ${target.runtimeKey}/agent-browser staged from ${agentBrowserPackage.sourceDescription}`
      );
    } finally {
      agentBrowserPackage.cleanup();
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

function getMachOArchOutput(
  projectRoot: string,
  filePath: string,
  label: string,
  fileArch: string
): string {
  const fileOutput = execFileSync("file", [relativeFromProjectRoot(projectRoot, filePath)], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!fileOutput.includes("Mach-O 64-bit executable") || !fileOutput.includes(fileArch)) {
    throw new Error(`Unexpected ${label} architecture: ${fileOutput}`);
  }
  return fileOutput;
}

export function validateStagedAgentClis(options: ValidateAgentCliOptions = {}): AgentCliManifest {
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
    const codexEntry = manifestEntries.find((entry) => entry.tool === "codex");
    if (!codexEntry) {
      throw new Error(`Agent CLI manifest is missing ${runtimeKey}/codex`);
    }
    assertCodexAppServerCompatible(codexEntry.source.version, `${runtimeKey}/codex`);

    for (const tool of ["codex", "claude", "rg", "agent-browser"] as const) {
      const executablePath = resolveStagedAgentCliPath(projectRoot, runtimeKey, tool);
      const inspection = inspectStaticExecutable(
        projectRoot,
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

    if (manifestEntries.length !== 4) {
      throw new Error(
        `Agent CLI manifest expected 4 entries for ${runtimeKey}, found ${manifestEntries.length}`
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
