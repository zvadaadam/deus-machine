import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { isExecError } from "@shared/lib/errors";

const parentBranchCache = new Map<string, { branch: string; expiresAt: number }>();
const PARENT_BRANCH_CACHE_TTL_MS = 5000;

export function verifyBranchExists(root_path: string, branch: string): string {
  const checks = [
    `refs/heads/${branch}`,
    `refs/remotes/origin/${branch}`,
    "refs/heads/main",
    "refs/heads/master",
  ];
  for (const ref of checks) {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", ref], {
        cwd: root_path,
        timeout: 2000,
      });
      if (ref.endsWith("/main")) return "main";
      if (ref.endsWith("/master")) return "master";
      return branch;
    } catch {}
  }
  return "main";
}

export function detectDefaultBranch(root_path: string): string {
  const strategies = [
    {
      name: "origin HEAD",
      fn: () => {
        const output = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
          cwd: root_path,
          encoding: "utf-8",
          timeout: 2000,
        }).trim();
        return output.replace(/^refs\/remotes\/origin\//, "");
      },
    },
    {
      name: "current branch",
      fn: () =>
        execFileSync("git", ["branch", "--show-current"], {
          cwd: root_path,
          encoding: "utf-8",
          timeout: 2000,
        }).trim(),
    },
    {
      name: "default fallback",
      fn: () => "main",
    },
  ];

  for (const strategy of strategies) {
    try {
      const branch = strategy.fn();
      if (branch) {
        return verifyBranchExists(root_path, branch);
      }
    } catch {}
  }

  return "main";
}

/**
 * Resolve the best parent branch ref for diff comparisons.
 *
 * ─── ARCHITECTURE DECISION: Remote-first, ALWAYS ──────────────────
 * We ALWAYS prefer origin/<branch> over local <branch>. This is NOT
 * a fallback strategy — it's the intended behavior:
 *
 *   1. Workspace creation fetches origin/<parent> and branches from it
 *      (see routes/workspaces.ts — POST /workspaces)
 *   2. Diffs show "what changed in this workspace vs upstream"
 *   3. PRs target the remote branch, so diffs match what the PR shows
 *
 * This is the authoritative implementation of parent branch resolution.
 * ──────────────────────────────────────────────────────────────────
 */
export function resolveParentBranch(
  workspacePath: string,
  parentBranch: string | null,
  defaultBranch: string | null
): string {
  const cacheKey = `${workspacePath}::${parentBranch || ""}::${defaultBranch || ""}`;
  const cached = parentBranchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.branch;
  }

  const cacheAndReturn = (branch: string): string => {
    parentBranchCache.set(cacheKey, { branch, expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS });
    return branch;
  };

  const candidates = [parentBranch, defaultBranch, "main", "master", "develop"].filter(
    Boolean
  ) as string[];

  // Build ref list: all remote refs first (intentional — see docstring), then local
  const refs = [
    ...candidates.map((b) => {
      const remote = b.startsWith("origin/") ? b : `origin/${b}`;
      return { refPath: `refs/remotes/${remote}`, result: remote };
    }),
    ...candidates.map((b) => ({ refPath: `refs/heads/${b}`, result: b })),
  ];

  for (const { refPath, result } of refs) {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", refPath], {
        cwd: workspacePath,
        timeout: 2000,
      });
      return cacheAndReturn(result);
    } catch {}
  }

  return cacheAndReturn(defaultBranch || "main");
}

export function resolveWorkspaceRelativePath(
  workspacePath: string,
  filePath: string
): string | null {
  if (!filePath || typeof filePath !== "string") return null;
  if (filePath.includes("\0")) return null;

  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) return null;

  const resolved = path.resolve(workspacePath, normalized);
  const relative = path.relative(workspacePath, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return relative;
}

export function normalizeGitPath(pathToken: string): string | null {
  if (!pathToken || typeof pathToken !== "string") return null;
  let cleaned = pathToken.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith("a/")) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith("b/")) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

export function splitGitDiffTokens(value: string): string[] {
  if (!value) return [];
  const tokens: string[] = [];
  let i = 0;
  while (i < value.length && tokens.length < 2) {
    while (value[i] === " ") i += 1;
    if (i >= value.length) break;
    if (value[i] === '"') {
      let end = i + 1;
      while (end < value.length && value[end] !== '"') end += 1;
      tokens.push(value.slice(i + 1, Math.min(end, value.length)));
      i = end + 1;
    } else {
      let end = i;
      while (end < value.length && value[end] !== " ") end += 1;
      tokens.push(value.slice(i, end));
      i = end + 1;
    }
  }
  return tokens;
}

export interface DiffInfo {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
}

export function extractDiffInfo(diffOutput: string): DiffInfo {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isNew = false;
  let isDeleted = false;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const tokens = splitGitDiffTokens(line.slice("diff --git ".length));
      if (tokens[0]) oldPath = normalizeGitPath(tokens[0]);
      if (tokens[1]) newPath = normalizeGitPath(tokens[1]);
      continue;
    }
    if (line.startsWith("rename from ")) {
      oldPath = normalizeGitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      newPath = normalizeGitPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("new file mode")) {
      isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      isDeleted = true;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const match = line.match(/^(---|\+\+\+)\s+([^\t\r\n]+)(.*)$/);
      if (!match) continue;
      const [, prefix, fileName] = match;
      if (fileName === "/dev/null") {
        if (prefix === "---") isNew = true;
        if (prefix === "+++") isDeleted = true;
        continue;
      }
      if (prefix === "---" && !oldPath) oldPath = normalizeGitPath(fileName);
      else if (prefix === "+++" && !newPath) newPath = normalizeGitPath(fileName);
    }
  }

  return { oldPath, newPath, isNew, isDeleted };
}

export function getGitFileContent(
  workspacePath: string,
  ref: string,
  filePath: string
): string | null {
  if (!filePath) return null;
  try {
    return execFileSync("git", ["show", `${ref}:${filePath}`], {
      cwd: workspacePath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    }).toString();
  } catch {
    return null;
  }
}

export function getMergeBase(workspacePath: string, parentBranch: string): string {
  try {
    return execFileSync("git", ["merge-base", parentBranch, "HEAD"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    // Fallback to HEAD — shows only uncommitted changes.
    // Previous fallback (parentBranch) caused phantom diffs when origin/main
    // advanced far beyond HEAD (thousands of false deletions).
    console.warn(`[GIT] merge-base failed for ${parentBranch}, falling back to HEAD`);
    return "HEAD";
  }
}

/** Returns untracked files (not ignored, not staged) in the workspace. */
function getUntrackedFiles(workspacePath: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 5000,
    })
      .toString()
      .trim();
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

/** Counts newlines in a file. Returns 0 for binary, oversized, or unreadable files. */
function countFileLines(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return 0;
    const buf = fs.readFileSync(filePath);
    // Detect binary files (null bytes in first 8KB)
    const sample = buf.subarray(0, 8192);
    if (sample.includes(0)) return 0;
    // Count lines (not newlines) to match git's line-counting semantics.
    // A file without a trailing newline still has its last line counted.
    if (buf.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    // If file doesn't end with a newline, the last line is still a line
    if (buf[buf.length - 1] !== 0x0a) count++;
    return count;
  } catch {
    return 0;
  }
}

/**
 * Aggregate diff stats (additions/deletions) from merge-base to working directory.
 * Uses `git diff <merge-base>` (without HEAD) to include committed + staged + unstaged
 * changes to tracked files. Separately counts untracked file lines as additions.
 */
export function getDiffStats(
  workspacePath: string,
  parentBranch: string
): { additions: number; deletions: number } {
  try {
    const mergeBase = getMergeBase(workspacePath, parentBranch);

    // Diff merge-base against working directory (committed + staged + unstaged tracked changes)
    const output = execFileSync("git", ["diff", mergeBase, "--shortstat"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 5000,
    })
      .toString()
      .trim();

    let additions = parseInt(output.match(/(\d+)\s+insertion(?:s)?/)?.[1] || "0", 10);
    const deletions = parseInt(output.match(/(\d+)\s+deletion(?:s)?/)?.[1] || "0", 10);

    // Add untracked files (each line counts as an addition)
    for (const file of getUntrackedFiles(workspacePath)) {
      additions += countFileLines(path.join(workspacePath, file));
    }

    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

/**
 * Per-file change list from merge-base to working directory.
 * Includes tracked changes (committed + staged + unstaged) and untracked files.
 */
export function getDiffFiles(
  workspacePath: string,
  parentBranch: string
): Array<{ file: string; additions: number; deletions: number }> {
  try {
    const mergeBase = getMergeBase(workspacePath, parentBranch);
    const files: Array<{ file: string; additions: number; deletions: number }> = [];

    // Tracked changes: diff merge-base against working directory
    const output = execFileSync("git", ["diff", mergeBase, "--numstat"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 5000,
    })
      .toString()
      .trim();

    if (output) {
      for (const line of output.split("\n")) {
        const [additions, deletions, file] = line.split("\t");
        files.push({
          file,
          additions: parseInt(additions, 10) || 0,
          deletions: parseInt(deletions, 10) || 0,
        });
      }
    }

    // Untracked files: count lines as additions
    for (const file of getUntrackedFiles(workspacePath)) {
      const lineCount = countFileLines(path.join(workspacePath, file));
      files.push({ file, additions: lineCount, deletions: 0 });
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Unified diff patch for a single file from merge-base to working directory.
 * Falls back to `--no-index` for untracked files.
 */
export function getFileDiff(workspacePath: string, parentBranch: string, filePath: string): string {
  // Defense-in-depth: validate even though callers should already sanitize
  const safePath = resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!safePath) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  const mergeBase = getMergeBase(workspacePath, parentBranch);

  // Diff merge-base against working directory for tracked files
  const output = execFileSync("git", ["diff", mergeBase, "--", safePath], {
    cwd: workspacePath,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5000,
  }).toString();

  if (output) return output;

  // File might be untracked — use --no-index to generate a diff from /dev/null
  // git diff --no-index exits with code 1 when differences exist, so catch the error
  try {
    return execFileSync("git", ["diff", "--no-index", "--", "/dev/null", safePath], {
      cwd: workspacePath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    }).toString();
  } catch (e: unknown) {
    // Exit code 1 = differences found (expected); stdout contains the diff
    if (isExecError(e) && e.stdout) return e.stdout.toString();
    throw e;
  }
}

export function getOpenCommand(target: string): { cmd: string; args: string[] } {
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", target] };
  if (process.platform === "darwin") return { cmd: "open", args: [target] };
  return { cmd: "xdg-open", args: [target] };
}
