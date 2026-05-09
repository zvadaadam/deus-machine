import * as fs from "fs";
import * as path from "path";

function getPackagedNodeModulesDir(): string | null {
  const resourcesPath = process.env.DEUS_RESOURCES_PATH;
  if (!resourcesPath) return null;
  return path.join(resourcesPath, "app.asar.unpacked", "node_modules");
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
  if (process.platform === "win32") {
    if (process.arch === "x64") return "x86_64-pc-windows-msvc";
    if (process.arch === "arm64") return "aarch64-pc-windows-msvc";
  }
  return null;
}

function getCodexPlatformPackageName(): string | null {
  if (process.platform === "linux") return `@openai/codex-linux-${process.arch}`;
  if (process.platform === "darwin") return `@openai/codex-darwin-${process.arch}`;
  if (process.platform === "win32") return `@openai/codex-win32-${process.arch}`;
  return null;
}

function getClaudePlatformPackageNames(): string[] {
  if (process.platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
      `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
    ];
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];
  }
  return [];
}

export function getPackagedClaudeCandidates(): string[] {
  const nodeModulesDir = getPackagedNodeModulesDir();
  if (!nodeModulesDir) return [];

  const executableName = process.platform === "win32" ? "claude.exe" : "claude";
  return getClaudePlatformPackageNames()
    .map((packageName) => path.join(nodeModulesDir, packageName, executableName))
    .filter((candidate) => fs.existsSync(candidate));
}

export function getPackagedCodexCandidates(): string[] {
  const nodeModulesDir = getPackagedNodeModulesDir();
  const packageName = getCodexPlatformPackageName();
  const targetTriple = getCodexTargetTriple();
  if (!nodeModulesDir || !packageName || !targetTriple) return [];

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const candidate = path.join(
    nodeModulesDir,
    packageName,
    "vendor",
    targetTriple,
    "codex",
    executableName
  );
  return fs.existsSync(candidate) ? [candidate] : [];
}
