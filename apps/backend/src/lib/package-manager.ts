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

/** Detect package manager from lockfile presence. Returns null if no lockfile found. */
export function detectPackageManagerFromLockfile(dirPath: string): NodePackageManager | null {
  return CANDIDATES.find(({ lockfiles }) => hasAnyFile(dirPath, lockfiles))?.packageManager ?? null;
}
