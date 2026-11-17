import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "@zvada/agent-server/server";
import { resolveRuntimeStagePaths } from "../../shared/runtime";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(runtimeDir, "../..");

interface AgentCliTarget {
  runtimeKey: "darwin-arm64" | "darwin-x64" | "linux-x64";
  agentBrowserEntry:
    | "bin/agent-browser-darwin-arm64"
    | "bin/agent-browser-darwin-x64"
    | "bin/agent-browser-linux-x64";
}

interface LockedPackage {
  lockKey: string;
  packageName: string;
  version: string;
  integrity: string;
}

export interface PrepareAgentCliOptions {
  log?: (line: string) => void;
  projectRoot?: string;
  runtimeKeys?: readonly AgentCliTarget["runtimeKey"][];
}

export const AGENT_CLI_TARGETS: readonly AgentCliTarget[] = [
  { runtimeKey: "darwin-arm64", agentBrowserEntry: "bin/agent-browser-darwin-arm64" },
  { runtimeKey: "darwin-x64", agentBrowserEntry: "bin/agent-browser-darwin-x64" },
  { runtimeKey: "linux-x64", agentBrowserEntry: "bin/agent-browser-linux-x64" },
] as const;

function relativeFromProjectRoot(projectRoot: string, targetPath: string): string {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

export function resolveStagedAgentCliPath(
  projectRoot: string,
  runtimeKey: string,
  tool: string
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
  rmSync(destination, { force: true });
  try {
    linkSync(source, destination);
  } catch {
    cpSync(source, destination);
  }
  chmodSync(destination, 0o755);
}

/**
 * Claude Code and Codex for one target, as agent-server installs them: the
 * builds its engine pins, each checked against its release table (Claude's
 * binary also against Anthropic's signed manifest), and staged from there in
 * Deus's flat layout.
 */
async function installEngineClis(
  projectRoot: string,
  runtimeKey: AgentCliTarget["runtimeKey"],
  log: (line: string) => void
): Promise<{
  claude: { path: string; version: string };
  codex: { root: string; version: string };
}> {
  // A build cache, outside dist/runtime, which a full build starts over.
  const dir = path.join(projectRoot, "node_modules", ".cache", "agent-server-clis");
  mkdirSync(dir, { recursive: true });
  log(`Installing ${runtimeKey} claude and codex with agent-server`);
  const results = await runInstall({
    dir,
    platforms: [runtimeKey],
    harnesses: ["claude-code", "codex-app-server"],
  });
  const installed = (tool: "claude" | "codex") => {
    const cli = results.find((result) => result.tool === tool)?.cli;
    if (!cli?.version) throw new Error(`agent-server installed no ${tool} for ${runtimeKey}`);
    return { path: cli.path, version: cli.version };
  };
  const codex = installed("codex");
  return {
    claude: installed("claude"),
    // <dir>/codex/<version>-<platform>/bin/codex: the package's vendor tree.
    codex: { root: path.dirname(path.dirname(codex.path)), version: codex.version },
  };
}

/** Stages Codex, Claude Code and agent-browser for each target; the packaged app is checked in afterPack. */
export async function prepareAgentClis(options: PrepareAgentCliOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const runtimeKeys = options.runtimeKeys ? new Set(options.runtimeKeys) : null;

  for (const target of AGENT_CLI_TARGETS) {
    if (runtimeKeys && !runtimeKeys.has(target.runtimeKey)) continue;

    const targetDir = path.dirname(
      resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "codex")
    );
    mkdirSync(targetDir, { recursive: true });

    const engine = await installEngineClis(projectRoot, target.runtimeKey, log);

    // Codex discovers its helper, shell and resources relative to the real
    // executable. Keep the installed tree intact; flat CLI aliases are for PATH.
    const payloadDir = path.join(targetDir, "codex-runtime");
    rmSync(payloadDir, { recursive: true, force: true });
    cpSync(engine.codex.root, payloadDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
    for (const [alias, entry] of [
      ["codex", "bin/codex"],
      ["rg", "codex-path/rg"],
    ]) {
      const aliasPath = path.join(targetDir, alias);
      rmSync(aliasPath, { force: true });
      symlinkSync(`codex-runtime/${entry}`, aliasPath);
    }
    log(`✓ ${target.runtimeKey}/codex ${engine.codex.version} staged`);

    copyExecutable(
      engine.claude.path,
      resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "claude")
    );
    log(`✓ ${target.runtimeKey}/claude ${engine.claude.version} staged`);

    const lockedAgentBrowser = readLockedPackage(projectRoot, "agent-browser");
    const agentBrowserPackage = await resolvePackageRoot(
      projectRoot,
      lockedAgentBrowser,
      target.agentBrowserEntry,
      log
    );
    try {
      copyExecutable(
        path.join(agentBrowserPackage.packageRoot, target.agentBrowserEntry),
        resolveStagedAgentCliPath(projectRoot, target.runtimeKey, "agent-browser")
      );
      log(
        `✓ ${target.runtimeKey}/agent-browser staged from ${agentBrowserPackage.sourceDescription}`
      );
    } finally {
      agentBrowserPackage.cleanup();
    }
  }
}
