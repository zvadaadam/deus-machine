import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

const CLI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9._+-]+$/;
const PACKAGED_SYSTEM_PATHS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function getElectronResourcesPath(): string | null {
  return (
    process.env.DEUS_RESOURCES_PATH ?? (process as { resourcesPath?: string }).resourcesPath ?? null
  );
}

function getRuntimeKey(): string | null {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }

  return null;
}

function isPackagedRuntime(): boolean {
  return process.env.DEUS_PACKAGED === "1" || process.env.DEUS_RUNTIME === "1";
}

export function getDevStagedCliDirectory(projectRoot = process.cwd()): string | null {
  const runtimeKey = getRuntimeKey();
  if (!runtimeKey) return null;

  return join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey);
}

function getBundledCliDirectoryCandidates(): string[] {
  const explicitBundledBinDir = process.env.DEUS_BUNDLED_BIN_DIR;
  if (explicitBundledBinDir) return [explicitBundledBinDir];

  const candidates: string[] = [];
  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath) candidates.push(join(resourcesPath, "bin"));
  if (isPackagedRuntime()) return [...new Set(candidates)];

  const devStagedCliDirectory = getDevStagedCliDirectory();
  if (devStagedCliDirectory) candidates.push(devStagedCliDirectory);

  return [...new Set(candidates)];
}

export function getBundledCliDirectory(): string | null {
  return getBundledCliDirectoryCandidates()[0] ?? null;
}

export function resolveBundledCliPath(tool: string): string | null {
  return getBundledCliPathCandidates(tool).find(isExecutableFile) ?? null;
}

export function getBundledCliPathCandidates(tool: string): string[] {
  if (!CLI_TOOL_NAME_PATTERN.test(tool)) return [];

  const executableName = process.platform === "win32" ? `${tool}.exe` : tool;
  return getBundledCliDirectoryCandidates().map((bundledCliDirectory) =>
    join(bundledCliDirectory, executableName)
  );
}

function missingPackagedCliPath(tool: string): string {
  const executableName = process.platform === "win32" ? `${tool}.exe` : tool;
  return process.platform === "win32"
    ? join("C:\\", "__deus_missing_bundled_bin__", executableName)
    : join("/", "__deus_missing_bundled_bin__", executableName);
}

function isExecutableFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;
  return (stat.mode & 0o111) !== 0;
}

export function resolveCliExecutable(tool: string): string {
  const bundledCliPath = resolveBundledCliPath(tool);
  if (bundledCliPath) return bundledCliPath;
  if (isPackagedRuntime()) return getBundledCliPathCandidates(tool)[0] ?? missingPackagedCliPath(tool);
  return tool;
}

export function extendCliPath(pathValue: string | undefined): string {
  const inheritedPathEntries = isPackagedRuntime()
    ? PACKAGED_SYSTEM_PATHS
    : (pathValue ?? "").split(delimiter);
  const pathEntries = [...getBundledCliDirectoryCandidates(), ...inheritedPathEntries]
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);

  return pathEntries.join(delimiter);
}
