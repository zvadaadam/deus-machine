import fs from "fs";
import path from "path";

export type NodePackageManager = "bun" | "pnpm" | "yarn" | "npm";

interface PackageManagerCandidate {
  packageManager: NodePackageManager;
  lockfiles: string[];
}

/** Detection order matters — first match wins. Bun first (project default). */
const CANDIDATES: PackageManagerCandidate[] = [
  { packageManager: "bun", lockfiles: ["bun.lock", "bun.lockb"] },
  { packageManager: "pnpm", lockfiles: ["pnpm-lock.yaml"] },
  { packageManager: "yarn", lockfiles: ["yarn.lock"] },
  { packageManager: "npm", lockfiles: ["package-lock.json"] },
];

function hasAnyFile(dirPath: string, fileNames: string[]): boolean {
  return fileNames.some((f) => fs.existsSync(path.join(dirPath, f)));
}

function hasPackageJson(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, "package.json"));
}

/** Detect package manager from lockfile presence. Returns null if no lockfile found. */
export function detectPackageManagerFromLockfile(dirPath: string): NodePackageManager | null {
  return CANDIDATES.find(({ lockfiles }) => hasAnyFile(dirPath, lockfiles))?.packageManager ?? null;
}

/**
 * Detect PM from lockfiles, falling back to "npm" if only package.json exists.
 * Returns null if no package.json exists at all.
 */
export function detectPackageManager(dirPath: string): NodePackageManager | null {
  if (!hasPackageJson(dirPath)) return null;
  return detectPackageManagerFromLockfile(dirPath) ?? "npm";
}

export interface PackageManagerCommand {
  command: string;
  args: string[];
}

/** Get the install command for a detected PM, with CI-appropriate flags when a lockfile exists. */
export function getInstallCommand(
  pm: NodePackageManager,
  hasLockfile: boolean
): PackageManagerCommand {
  if (pm === "npm") {
    return { command: "npm", args: [hasLockfile ? "ci" : "install"] };
  }
  const args = ["install"];
  if (hasLockfile) args.push("--frozen-lockfile");
  return { command: pm, args };
}

/** Get the run prefix for a PM (e.g. "npm run" vs "bun run"). */
export function getRunPrefix(pm: NodePackageManager): string {
  return pm === "npm" ? "npm run" : `${pm} run`;
}

/**
 * Detect PM and return the appropriate install command.
 * Returns null if no package.json exists. Uses frozen-lockfile/ci flags when a lockfile is present.
 */
export function detectInstallCommand(dirPath: string): PackageManagerCommand | null {
  if (!hasPackageJson(dirPath)) return null;
  const fromLockfile = detectPackageManagerFromLockfile(dirPath);
  return fromLockfile ? getInstallCommand(fromLockfile, true) : getInstallCommand("npm", false);
}
