import fs from "node:fs/promises";
import path from "node:path";
import type { FileDiff } from "@shared/api/workspaces";
import { GitError, runGit } from "@shared/lib/git-process";
import type { DiffStats, FileChange, FileChangeStatus } from "@shared/types/workspace";
import { ConflictError, NotFoundError } from "../lib/errors";

/** Outlasts several sidebar polls. Retargeting a workspace changes the key immediately. */
const parentBranchCache = new Map<string, { branch: string; expiresAt: number }>();
const PARENT_BRANCH_CACHE_TTL_MS = 30_000;

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", ref], { cwd, timeoutMs: 2000 });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return false;
    throw error;
  }
}

export async function detectDefaultBranch(cwd: string): Promise<string> {
  const options = { cwd, timeoutMs: 2000 };
  const origin = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], options).catch(
    () => ""
  );
  const branch =
    origin.trim().replace(/^refs\/remotes\/origin\//, "") ||
    (await runGit(["branch", "--show-current"], options).catch(() => "")).trim() ||
    "main";
  return verifyBranchExists(cwd, branch);
}

export async function verifyBranchExists(cwd: string, branch: string): Promise<string> {
  try {
    if (await hasRef(cwd, `refs/heads/${branch}`)) return branch;
    if (await hasRef(cwd, `refs/remotes/origin/${branch}`)) return branch;
    if (await hasRef(cwd, "refs/heads/main")) return "main";
    if (await hasRef(cwd, "refs/heads/master")) return "master";
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
  }
  return "main";
}

/** Prefer every remote candidate to a local branch: the comparison follows the PR's base. */
export async function resolveParentBranch(
  workspacePath: string,
  parentBranch: string | null,
  defaultBranch: string | null
): Promise<string> {
  const cacheKey = `${workspacePath}::${parentBranch || ""}::${defaultBranch || ""}`;
  const cached = parentBranchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.branch;

  const candidates = [
    ...new Set([parentBranch, defaultBranch, "main", "master", "develop"]),
  ].filter((branch): branch is string => !!branch);
  const remotes = candidates.map((b) => (b.startsWith("origin/") ? b : `origin/${b}`));
  const refs = [
    ...remotes.map((branch) => ({ ref: `refs/remotes/${branch}`, branch })),
    ...candidates.map((branch) => ({ ref: `refs/heads/${branch}`, branch })),
  ];
  for (const { ref, branch } of refs) {
    if (await hasRef(workspacePath, ref)) {
      parentBranchCache.set(cacheKey, {
        branch,
        expiresAt: Date.now() + PARENT_BRANCH_CACHE_TTL_MS,
      });
      return branch;
    }
  }
  throw new ConflictError("Could not read the changes: the comparison branch could not be found.");
}

export function resolveWorkspaceRelativePath(
  workspacePath: string,
  filePath: unknown
): string | null {
  if (typeof filePath !== "string" || filePath.includes("\0") || path.isAbsolute(filePath))
    return null;
  const relative = path.relative(workspacePath, path.resolve(workspacePath, filePath));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  return relative.split(path.sep).join("/");
}

export async function getMergeBase(cwd: string, parentBranch: string): Promise<string> {
  try {
    const base = (
      await runGit(["merge-base", parentBranch, "HEAD"], { cwd, timeoutMs: 5000 })
    ).trim();
    if (!base) throw new ConflictError("Could not read the changes: git returned no merge base.");
    return base;
  } catch (error) {
    // Unrelated histories: compare the working tree to HEAD.
    if (error instanceof GitError && error.code === 1 && !error.stdout && !error.stderr)
      return "HEAD";
    throw error;
  }
}

const gitStatus: Partial<Record<string, FileChangeStatus>> = {
  A: "added",
  D: "deleted",
  R: "renamed",
};

/** git diff --raw --numstat -z writes all raw records first, then the line counts. */
export function parseDiffFiles(output: string): Map<string, FileChange> {
  const fields = output.split("\0");
  if (fields.pop() !== "") throw new Error("Unterminated git diff record");
  const changes = new Map<string, FileChange>();
  let i = 0;
  const readPath = () => {
    const file = fields[i++];
    if (!file) throw new Error("Git diff record is missing a path");
    return file;
  };
  let header: RegExpExecArray | null;
  while ((header = /^:\d{6} \d{6} [a-f0-9]+ [a-f0-9]+ ([A-Z])\d*$/.exec(fields[i]))) {
    i++;
    const letter = header[1];
    const first = readPath();
    const file = letter === "R" || letter === "C" ? readPath() : first;
    const status = gitStatus[letter] ?? "modified";
    // An unmerged path can also have a record for the working file.
    if (status === "modified" && changes.has(file)) continue;
    changes.set(file, {
      file,
      status,
      ...(letter === "R" && { previous_path: first }),
      additions: 0,
      deletions: 0,
    });
  }
  while (i < fields.length) {
    const record = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i++]);
    if (!record) throw new Error("Invalid git numstat record");
    let file = record[3];
    if (!file) {
      readPath(); // Source of a rename or copy.
      file = readPath();
    }
    const change: FileChange = changes.get(file) ?? {
      file,
      status: "modified",
      additions: 0,
      deletions: 0,
    };
    change.additions += Number(record[1]) || 0;
    change.deletions += Number(record[2]) || 0;
    changes.set(file, change);
  }
  return changes;
}

async function changedPaths(cwd: string, base: string, requested?: string) {
  const output = await runGit(["diff", base, "-M", "--raw", "--numstat", "-z", "--"], {
    cwd,
    timeoutMs: 5000,
  });
  const changes = parseDiffFiles(output);
  const selected = requested ? changes.get(requested) : undefined;
  const untracked: FileChange[] = [];
  if (selected && selected.status !== "deleted") return { changes, untracked };

  // One row per path. A staged deletion can leave an untracked replacement on disk.
  for (const file of await untrackedFiles(cwd, requested)) {
    const tracked = changes.get(file);
    if (tracked && tracked.status !== "deleted") continue;
    const change: FileChange = {
      file,
      status: tracked ? "modified" : "added",
      additions: 0,
      deletions: tracked?.deletions ?? 0,
    };
    changes.set(file, change);
    untracked.push(change);
  }
  return { changes, untracked };
}

async function untrackedFiles(cwd: string, file?: string): Promise<string[]> {
  const args = ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--"];
  if (file) args.push(file);
  return (await runGit(args, { cwd, timeoutMs: 5000 })).split("\0").slice(0, -1);
}

/** Git records the link itself. Following it could read outside the workspace. */
async function readWorkingFile(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) return await fs.readlink(filePath, { encoding: "buffer" });
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return null;
    const bytes = await fs.readFile(filePath);
    return bytes.subarray(0, 8192).includes(0) ? null : bytes;
  } catch {
    return null;
  }
}

async function countFileLines(filePath: string): Promise<number> {
  const bytes = await readWorkingFile(filePath);
  if (!bytes?.length) return 0;
  let count = bytes[bytes.length - 1] === 0x0a ? 0 : 1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) count++;
  }
  return count;
}

export async function getDiffFiles(cwd: string, parentBranch: string): Promise<FileChange[]> {
  const base = await getMergeBase(cwd, parentBranch);
  const { changes, untracked } = await changedPaths(cwd, base);
  for (const change of untracked) {
    change.additions = await countFileLines(path.join(cwd, change.file));
  }
  return [...changes.values()];
}

export function sumDiffStats(files: readonly DiffStats[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

export async function getDiffStats(cwd: string, parentBranch: string): Promise<DiffStats> {
  return sumDiffStats(await getDiffFiles(cwd, parentBranch));
}

export async function getGitFileContent(
  cwd: string,
  base: string,
  file: string
): Promise<string | null> {
  try {
    const blob = await runGit(["cat-file", "blob", `${base}:${file}`], { cwd, timeoutMs: 5000 });
    return blob.slice(0, 8192).includes("\0") ? null : blob;
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

export async function getFileDiff(
  cwd: string,
  parentBranch: string,
  file: string
): Promise<FileDiff> {
  const base = await getMergeBase(cwd, parentBranch);
  const { changes, untracked } = await changedPaths(cwd, base, file);
  const change = changes.get(file);
  if (!change) throw new NotFoundError("This file has no changes.");
  const { status, previous_path: previous } = change;
  const noIndex = status === "added" && untracked.includes(change);
  const args = [
    "--literal-pathspecs",
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  if (noIndex) args.push("--no-index", "--", "/dev/null", file);
  else args.push(base, "-M", "--", ...(previous ? [previous] : []), file);
  const diff = await runGit(args, { cwd, timeoutMs: 5000 }).catch((error: unknown) => {
    if (noIndex && error instanceof GitError && error.code === 1) return error.stdout;
    throw error;
  });

  const oldContent = status === "added" ? "" : await getGitFileContent(cwd, base, previous ?? file);
  const newContent =
    status === "deleted"
      ? ""
      : ((await readWorkingFile(path.join(cwd, file)))?.toString("utf8") ?? null);
  return { file, diff, old_content: oldContent, new_content: newContent };
}
