import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { isExecError } from "@shared/lib/errors";
import { ConflictError } from "../lib/errors";

// Every git call here is asynchronous: the backend's event loop also runs the
// agent engine, and the web app asks for diff stats of every working
// workspace every few seconds. A synchronous spawn stalls every chat stream.
const execFileAsync = promisify(execFile);

/**
 * Outlasts several 5-second diff polls. The key holds the workspace's target
 * and default branch, so retargeting a workspace misses the cache at once;
 * only a ref appearing or vanishing for the same key waits for expiry.
 */
const parentBranchCache = new Map<string, { branch: string; expiresAt: number }>();
const PARENT_BRANCH_CACHE_TTL_MS = 30_000;

export async function verifyBranchExists(root_path: string, branch: string): Promise<string> {
  const checks = [
    `refs/heads/${branch}`,
    `refs/remotes/origin/${branch}`,
    "refs/heads/main",
    "refs/heads/master",
  ];
  for (const ref of checks) {
    try {
      await execFileAsync("git", ["show-ref", "--verify", "--quiet", ref], {
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

export async function detectDefaultBranch(root_path: string): Promise<string> {
  const strategies = [
    {
      name: "origin HEAD",
      fn: async () => {
        const { stdout } = await execFileAsync(
          "git",
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            cwd: root_path,
            encoding: "utf-8",
            timeout: 2000,
          }
        );
        return stdout.trim().replace(/^refs\/remotes\/origin\//, "");
      },
    },
    {
      name: "current branch",
      fn: async () => {
        const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
          cwd: root_path,
          encoding: "utf-8",
          timeout: 2000,
        });
        return stdout.trim();
      },
    },
    {
      name: "default fallback",
      fn: async () => "main",
    },
  ];

  for (const strategy of strategies) {
    try {
      const branch = await strategy.fn();
      if (branch) {
        return await verifyBranchExists(root_path, branch);
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
export async function resolveParentBranch(
  workspacePath: string,
  parentBranch: string | null,
  defaultBranch: string | null
): Promise<string> {
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
      await execFileAsync("git", ["show-ref", "--verify", "--quiet", refPath], {
        cwd: workspacePath,
        timeout: 2000,
      });
      return cacheAndReturn(result);
    } catch (error) {
      // show-ref --verify --quiet exits 1 when the ref does not exist.
      if (!isExecError(error) || error.code !== 1 || error.killed) throw error;
    }
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

export async function getGitFileContent(
  workspacePath: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  if (!filePath) return null;
  try {
    const { stdout } = await execFileAsync("git", ["show", `${ref}:${filePath}`], {
      cwd: workspacePath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function getMergeBase(workspacePath: string, parentBranch: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["merge-base", parentBranch, "HEAD"], {
    cwd: workspacePath,
    encoding: "utf-8",
    timeout: 5000,
  });
  const base = stdout.trim();
  if (!base) throw new ConflictError("Could not read the changes: git returned no merge base.");
  return base;
}

/** Returns untracked files (not ignored, not staged) in the workspace. */
async function getUntrackedFiles(workspacePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: workspacePath,
    encoding: "utf-8",
    timeout: 5000,
  });
  const output = stdout.trim();
  return output ? output.split("\n") : [];
}

/** Counts newlines in a file. Returns 0 for binary, oversized, or unreadable files. */
async function countFileLines(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 10 * 1024 * 1024) return 0;
    const buf = await fs.readFile(filePath);
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
export async function getDiffStats(
  workspacePath: string,
  parentBranch: string
): Promise<{ additions: number; deletions: number }> {
  const mergeBase = await getMergeBase(workspacePath, parentBranch);

  // Diff merge-base against working directory (committed + staged + unstaged tracked changes)
  const { stdout } = await execFileAsync("git", ["diff", mergeBase, "--shortstat"], {
    cwd: workspacePath,
    encoding: "utf-8",
    timeout: 5000,
  });
  const output = stdout.trim();

  let additions = parseInt(output.match(/(\d+)\s+insertion(?:s)?/)?.[1] || "0", 10);
  const deletions = parseInt(output.match(/(\d+)\s+deletion(?:s)?/)?.[1] || "0", 10);

  // Add untracked files (each line counts as an addition)
  for (const file of await getUntrackedFiles(workspacePath)) {
    additions += await countFileLines(path.join(workspacePath, file));
  }

  return { additions, deletions };
}

/**
 * Per-file change list from merge-base to working directory.
 * Includes tracked changes (committed + staged + unstaged) and untracked files.
 */
export async function getDiffFiles(
  workspacePath: string,
  parentBranch: string
): Promise<Array<{ file: string; additions: number; deletions: number }>> {
  const mergeBase = await getMergeBase(workspacePath, parentBranch);
  const files: Array<{ file: string; additions: number; deletions: number }> = [];

  // Tracked changes: diff merge-base against working directory
  const { stdout } = await execFileAsync("git", ["diff", mergeBase, "--numstat"], {
    cwd: workspacePath,
    encoding: "utf-8",
    timeout: 5000,
  });
  const output = stdout.trim();

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
  for (const file of await getUntrackedFiles(workspacePath)) {
    const lineCount = await countFileLines(path.join(workspacePath, file));
    files.push({ file, additions: lineCount, deletions: 0 });
  }

  return files;
}

/**
 * Unified diff patch for a single file from merge-base to working directory.
 * Falls back to `--no-index` for untracked files.
 */
export async function getFileDiff(
  workspacePath: string,
  mergeBase: string,
  filePath: string
): Promise<string> {
  // Defense-in-depth: validate even though callers should already sanitize
  const safePath = resolveWorkspaceRelativePath(workspacePath, filePath);
  if (!safePath) {
    throw new Error(`Invalid file path: ${filePath}`);
  }

  // Diff merge-base against working directory for tracked files
  const { stdout: output } = await execFileAsync("git", ["diff", mergeBase, "--", safePath], {
    cwd: workspacePath,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5000,
  });

  if (output) return output;

  // File might be untracked — use --no-index to generate a diff from /dev/null
  // git diff --no-index exits with code 1 when differences exist, so catch the error
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--", "/dev/null", safePath],
      { cwd: workspacePath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 5000 }
    );
    return stdout;
  } catch (e: unknown) {
    // Exit code 1 = differences found (expected); stdout contains the diff
    if (isExecError(e) && e.code === 1 && !e.killed && e.stdout) return e.stdout;
    throw e;
  }
}
