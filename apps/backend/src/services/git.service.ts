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

/** Prefer the remote refs for the workspace's target and default branches. */
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
      return (await runGit(["rev-parse", "--verify", "HEAD"], { cwd, timeoutMs: 5000 })).trim();
    throw error;
  }
}

const gitStatus: Partial<Record<string, FileChangeStatus>> = {
  A: "added",
  D: "deleted",
  R: "renamed",
};

interface ChangedPath {
  change: FileChange;
  raw?: { oldMode: string; newMode: string; oldOid: string };
}

/** git diff --raw --numstat -z writes all raw records first, then the line counts. */
export function parseDiffFiles(output: string): Map<string, ChangedPath> {
  const fields = output.split("\0");
  if (fields.pop() !== "") throw new Error("Unterminated git diff record");
  const changes = new Map<string, ChangedPath>();
  let i = 0;
  const readPath = () => {
    const file = fields[i++];
    if (!file) throw new Error("Git diff record is missing a path");
    return file;
  };
  let header: RegExpExecArray | null;
  while ((header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) [a-f0-9]+ ([A-Z])\d*$/.exec(fields[i]))) {
    i++;
    const [, oldMode, newMode, oldOid, letter] = header;
    const first = readPath();
    const file = letter === "R" || letter === "C" ? readPath() : first;
    const status = gitStatus[letter] ?? "modified";
    // An unmerged path can also have a record for the working file.
    const known = changes.get(file);
    if (known && (letter === "U" || (status === "modified" && known.change.status !== "modified")))
      continue;
    changes.set(file, {
      change: {
        file,
        status,
        ...(letter === "R" && { previous_path: first }),
        additions: 0,
        deletions: 0,
      },
      raw: { oldMode, newMode, oldOid },
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
    const entry: ChangedPath = changes.get(file) ?? {
      change: { file, status: "modified", additions: 0, deletions: 0 },
    };
    entry.change.additions += Number(record[1]) || 0;
    entry.change.deletions += Number(record[2]) || 0;
    changes.set(file, entry);
  }
  return changes;
}

const pendingChanges = new Map<string, Promise<Map<string, ChangedPath>>>();

function changedPaths(cwd: string, base: string) {
  const key = cwd + "\0" + base;
  const pending = pendingChanges.get(key);
  if (pending) return pending;
  const read = readChangedPaths(cwd, base).finally(() => pendingChanges.delete(key));
  pendingChanges.set(key, read);
  return read;
}

async function readChangedPaths(cwd: string, base: string) {
  const options = { cwd, timeoutMs: 5000 };
  const tracked = await runGit(["diff", base, "-M", "--raw", "--numstat", "-z", "--"], options);
  const changes = parseDiffFiles(tracked);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], options);
  // One row per path. A staged deletion can leave an untracked replacement on disk.
  for (const file of untracked.split("\0").slice(0, -1)) {
    const entry = changes.get(file);
    if (entry && entry.change.status !== "deleted") continue;
    const additions = await countFileLines(path.join(cwd, file));
    if (entry) {
      entry.change.status = "modified";
      entry.change.additions = additions;
    } else {
      changes.set(file, { change: { file, status: "added", additions, deletions: 0 } });
    }
  }
  return changes;
}

/** Git records the link itself. Following it could read outside the workspace. */
async function readWorkingFile(filePath: string) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink())
      return { symlink: true, bytes: await fs.readlink(filePath, { encoding: "buffer" }) };
    if (!stat.isFile()) return null;
    if (stat.size > 10 * 1024 * 1024) return { symlink: false, bytes: null };
    const bytes = await fs.readFile(filePath);
    return { symlink: false, bytes: bytes.subarray(0, 8192).includes(0) ? null : bytes };
  } catch {
    return null;
  }
}

async function countFileLines(filePath: string): Promise<number> {
  const bytes = (await readWorkingFile(filePath))?.bytes;
  if (!bytes?.length) return 0;
  let count = bytes[bytes.length - 1] === 0x0a ? 0 : 1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) count++;
  }
  return count;
}

export async function getDiffFiles(cwd: string, parentBranch: string): Promise<FileChange[]> {
  const base = await getMergeBase(cwd, parentBranch);
  return Array.from((await changedPaths(cwd, base)).values(), ({ change }) => change);
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
  const entry = (await changedPaths(cwd, base)).get(file);
  if (!entry) throw new NotFoundError("This file has no changes.");
  const {
    change: { status, previous_path },
    raw,
  } = entry;
  const source = previous_path ?? file;
  let oldContent: string | null = null;
  if (status === "added") oldContent = "";
  else if (raw?.oldMode !== "160000") oldContent = await getGitFileContent(cwd, base, source);
  const hasWorkingBlob = status !== "deleted" && raw?.newMode !== "160000";
  const working = hasWorkingBlob ? await readWorkingFile(path.join(cwd, file)) : null;
  const newContent = status === "deleted" ? "" : (working?.bytes?.toString("utf8") ?? null);
  const result = { file, diff: "", old_content: oldContent, new_content: newContent };
  // A gitlink names a commit. Passing it to diff would select a tree instead of a blob.
  if (raw?.oldMode === "160000" || raw?.newMode === "160000") return result;
  const options = { cwd, timeoutMs: 5000 };
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
  if (status === "deleted") {
    // This path is a leaf in the base. The empty tree has no descendants, even if the worktree does.
    const emptyTree = (await runGit(["hash-object", "-t", "tree", "--stdin"], options)).trim();
    args.push(base, emptyTree, "--", file);
  } else if (!working) {
    return result;
  } else if (status === "added") {
    args.push("--no-index", "--", "/dev/null", file);
  } else {
    let { oldMode, oldOid } = raw ?? {};
    if (!oldMode || oldMode === "000000") {
      // A numstat-only or unmerged record can omit the base object.
      const format = "--format=%(objectmode) %(objectname)";
      const lookup = ["--literal-pathspecs", "ls-tree", format, base, "--", source];
      [oldMode, oldOid] = (await runGit(lookup, options)).trim().split(" ");
    }
    if (!oldOid || oldMode === "040000" || oldMode === "160000") return result;
    // A bare blob compares link text with regular bytes in one hunk across a type change.
    const typeChanged = (oldMode === "120000") !== working.symlink;
    args.push(typeChanged ? `${oldOid}^{blob}` : `${base}:${source}`, "--", file);
  }
  result.diff = await runGit(args, options).catch((error: unknown) => {
    if (status === "added" && error instanceof GitError && error.code === 1) return error.stdout;
    throw error;
  });
  return result;
}
