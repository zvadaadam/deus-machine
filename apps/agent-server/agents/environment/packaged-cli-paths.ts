import * as fs from "fs";
import * as path from "path";

function getRuntimeKey(): string | null {
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    return `darwin-${process.arch}`;
  }
  return null;
}

function getPackagedNodeModulesDirs(): string[] {
  const candidates: string[] = [];
  const resourcesPathCandidates = [
    process.env.DEUS_RESOURCES_PATH,
    (process as { resourcesPath?: string }).resourcesPath,
  ].filter(Boolean) as string[];

  for (const resourcesPath of resourcesPathCandidates) {
    candidates.push(path.join(resourcesPath, "app.asar.unpacked", "node_modules"));
  }

  for (const projectRoot of findProjectRoots()) {
    candidates.push(path.join(projectRoot, "node_modules"));
  }

  return uniqueExisting(candidates);
}

function getPackagedBinCandidates(binaryName: string): string[] {
  const candidates: string[] = [];

  if (process.env.DEUS_BUNDLED_BIN_DIR) {
    candidates.push(path.join(process.env.DEUS_BUNDLED_BIN_DIR, binaryName));
  }

  if (process.env.DEUS_RESOURCES_PATH) {
    candidates.push(path.join(process.env.DEUS_RESOURCES_PATH, "bin", binaryName));
  }

  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "bin", binaryName));
  }

  const runtimeKey = getRuntimeKey();
  if (runtimeKey) {
    for (const projectRoot of findProjectRoots()) {
      candidates.push(
        path.join(projectRoot, "dist", "runtime", "electron", "bin", runtimeKey, binaryName)
      );
    }
  }

  return uniqueExisting(candidates);
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

export function getPackagedClaudeCandidates(): string[] {
  const candidates = getPackagedBinCandidates("claude");
  for (const packageName of getClaudePlatformPackageNames()) {
    for (const nodeModulesDir of getPackagedNodeModulesDirs()) {
      candidates.push(path.join(nodeModulesDir, packageName, "claude"));
    }
    const packageDir = resolvePackageDir(packageName);
    if (packageDir) candidates.push(path.join(packageDir, "claude"));
  }
  return uniqueExisting(candidates);
}

export function getPackagedCodexCandidates(): string[] {
  const candidates = getPackagedBinCandidates("codex");
  const packageName = getCodexPlatformPackageName();
  const targetTriple = getCodexTargetTriple();
  if (!packageName || !targetTriple) return candidates;

  for (const nodeModulesDir of getPackagedNodeModulesDirs()) {
    candidates.push(
      path.join(nodeModulesDir, packageName, "vendor", targetTriple, "codex", "codex")
    );
  }

  const packageDir = resolvePackageDir(packageName);
  if (packageDir) {
    candidates.push(path.join(packageDir, "vendor", targetTriple, "codex", "codex"));
  }

  return uniqueExisting(candidates);
}

function findProjectRoots(): string[] {
  const starts = [
    process.env.DEUS_PROJECT_ROOT,
    process.cwd(),
    process.argv[1] ? path.dirname(process.argv[1]) : "",
    __dirname,
  ].filter(Boolean) as string[];

  const roots: string[] = [];
  for (const start of starts) {
    const root = findProjectRoot(start);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function findProjectRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, "apps", "agent-server"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePackageDir(packageName: string): string | null {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

function uniqueExisting(candidates: string[]): string[] {
  return Array.from(new Set(candidates.filter(Boolean))).filter((candidate) =>
    fs.existsSync(candidate)
  );
}
