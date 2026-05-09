import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const COMMON_CLI_PATH_FALLBACKS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
const CLI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9._+-]+$/;

function getElectronResourcesPath(): string | null {
  return (process as { resourcesPath?: string }).resourcesPath ?? null;
}

function getRuntimeKey(): string | null {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }

  return null;
}

function getDevStagedCliDirectory(): string | null {
  const runtimeKey = getRuntimeKey();
  if (!runtimeKey) return null;

  return join(process.cwd(), "dist", "runtime", "electron", "bin", runtimeKey);
}

function getBundledCliDirectoryCandidates(): string[] {
  const explicitBundledBinDir = process.env.DEUS_BUNDLED_BIN_DIR;
  if (explicitBundledBinDir) return [explicitBundledBinDir];

  const candidates: string[] = [];
  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath) candidates.push(join(resourcesPath, "bin"));

  const devStagedCliDirectory = getDevStagedCliDirectory();
  if (devStagedCliDirectory) candidates.push(devStagedCliDirectory);

  return [...new Set(candidates)];
}

export function getBundledCliDirectory(): string | null {
  return getBundledCliDirectoryCandidates()[0] ?? null;
}

export function resolveBundledCliPath(tool: string): string | null {
  if (!CLI_TOOL_NAME_PATTERN.test(tool)) return null;

  const executableName = process.platform === "win32" ? `${tool}.exe` : tool;
  for (const bundledCliDirectory of getBundledCliDirectoryCandidates()) {
    const candidate = join(bundledCliDirectory, executableName);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export function resolveCliExecutable(tool: string): string {
  return resolveBundledCliPath(tool) ?? tool;
}

export function extendCliPath(pathValue: string | undefined): string {
  const pathEntries = [...getBundledCliDirectoryCandidates(), ...(pathValue ?? "").split(delimiter)]
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);

  // Homebrew/MacPorts locations are POSIX-only — appending them on Windows is
  // harmless (they just don't resolve), but the delimiter must match the host.
  for (const fallback of COMMON_CLI_PATH_FALLBACKS) {
    if (!pathEntries.includes(fallback)) pathEntries.push(fallback);
  }
  return pathEntries.join(delimiter);
}
