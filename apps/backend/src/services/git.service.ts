import fs from "node:fs/promises";
import path from "node:path";
import type { FileDiff } from "@shared/api/workspaces";
import { GitError, runGit } from "@shared/lib/git-process";
import type { DiffStats, FileChange, FileChangeStatus } from "@shared/types/workspace";
import { ConflictError, NotFoundError } from "../lib/errors";
import { isBinaryContent } from "../lib/file-content";

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
  oldMode?: string;
  newMode?: string;
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
  while ((header = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])\d*$/.exec(fields[i]))) {
    i++;
    const [, oldMode, newMode, letter] = header;
    const first = readPath();
    const file = letter === "R" || letter === "C" ? readPath() : first;
    const status = gitStatus[letter] ?? "modified";
    // An unmerged path can also have a record for the working file.
    const known = changes.get(file);
    if (known && (letter === "U" || (status === "modified" && known.change.status !== "modified")))
      continue;
    const change: FileChange = { file, status, additions: 0, deletions: 0 };
    if (letter === "R") change.previous_path = first;
    const hasSourceMode = letter !== "C" && !(letter === "U" && oldMode === "000000");
    changes.set(file, { change, oldMode: hasSourceMode ? oldMode : undefined, newMode });
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

export function sharePending<T>(read: (cwd: string, base: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return (cwd: string, base: string) => {
    const key = cwd + "\0" + base;
    let result = pending.get(key);
    if (!result) {
      result = read(cwd, base).finally(() => pending.delete(key));
      pending.set(key, result);
    }
    return result;
  };
}

async function trackedChanges(cwd: string, base: string) {
  const args = ["diff", base, "-M", "--raw", "--numstat", "-z", "--"];
  return parseDiffFiles(await runGit(args, { cwd, timeoutMs: 5000 }));
}

// Opens can share rename sources. A list or total must see the checkout as it stands when asked.
const trackedForOpen = sharePending(trackedChanges);

async function untrackedFiles(cwd: string, file?: string) {
  const args = ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--"];
  if (file !== undefined) args.push(file);
  return (await runGit(args, { cwd, timeoutMs: 5000 })).split("\0").slice(0, -1);
}

// One row per path. A staged deletion can leave an untracked replacement on disk.
function statusIfUntracked(status?: FileChangeStatus) {
  if (!status) return "added";
  if (status === "deleted") return "modified";
}

/** Git records the link itself. Following it could read outside the workspace. */
async function readWorkingFile(filePath: string) {
  const stat = await fs.lstat(filePath, { bigint: true }).catch(() => null);
  if (!stat) return null;
  let content: Promise<Buffer> | undefined;
  if (stat.isSymbolicLink()) content = fs.readlink(filePath, { encoding: "buffer" });
  else if (!stat.isFile()) return null;
  else if (stat.size <= 10 * 1024 * 1024) content = fs.readFile(filePath);
  const bytes = await content?.catch(() => null);
  return { stat, bytes: bytes && !isBinaryContent(bytes) ? bytes : null };
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

const COUNT_CONCURRENCY = 8;
export async function getDiffFiles(cwd: string, parentBranch: string): Promise<FileChange[]> {
  const base = await getMergeBase(cwd, parentBranch);
  const [files, untracked] = await Promise.all([trackedChanges(cwd, base), untrackedFiles(cwd)]);
  const names = untracked.values();
  async function countUntracked() {
    for (const file of names) {
      const { status: trackedStatus, deletions = 0 } = files.get(file)?.change ?? {};
      const status = statusIfUntracked(trackedStatus);
      if (!status) continue;
      const change: FileChange = { file, status, additions: 0, deletions };
      files.set(file, { change });
      change.additions = await countFileLines(path.join(cwd, file));
    }
  }
  const workers = Math.min(COUNT_CONCURRENCY, untracked.length);
  await Promise.all(Array.from({ length: workers }, countUntracked));
  return Array.from(files.values(), ({ change }) => change);
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

async function getGitFileContent(cwd: string, blob: string) {
  try {
    const content = await runGit(["cat-file", "blob", blob], { cwd, timeoutMs: 5000 });
    return content.slice(0, 8192).includes("\0") ? null : content;
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

async function gitPatch(cwd: string, ...args: string[]) {
  const format = ["--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
  const command = ["--literal-pathspecs", "-c", "core.quotePath=false", "diff", ...format, ...args];
  try {
    return await runGit(command, { cwd, timeoutMs: 5000 });
  } catch (error) {
    if (args[0] === "--no-index" && error instanceof GitError && error.code === 1 && error.stdout)
      return error.stdout;
    throw error;
  }
}

async function readWorkingDiff(cwd: string, file: string, blob: string | null): Promise<FileDiff> {
  const filePath = path.join(cwd, file);
  const changed = "This file changed while it was being read.";
  const { stat, bytes } = (await readWorkingFile(filePath)) ?? {};
  if (!stat) throw new ConflictError(changed);
  const args = blob ? [blob, "--", file] : ["--no-index", "--", "/dev/null", file];
  const diff = await gitPatch(cwd, ...args).finally(async () => {
    const after = await fs.lstat(filePath, { bigint: true }).catch(() => null);
    if (
      !after ||
      !(stat.isFile() ? after.isFile() : after.isSymbolicLink()) ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ino !== stat.ino
    )
      throw new ConflictError(changed);
  });
  const old_content = blob ? await getGitFileContent(cwd, blob) : "";
  return { file, diff, old_content, new_content: bytes?.toString("utf8") ?? null };
}

export async function getFileDiff(
  cwd: string,
  parentBranch: string,
  file: string
): Promise<FileDiff> {
  const base = await getMergeBase(cwd, parentBranch);
  const entry = (await trackedForOpen(cwd, base)).get(file);
  let status = entry?.change.status;
  const untracked = statusIfUntracked(status);
  if (untracked && (await untrackedFiles(cwd, file)).includes(file)) status = untracked;
  if (!status) throw new NotFoundError("This file has no changes.");

  const source = entry?.change.previous_path ?? file;
  const basePath = `${base}:${source}`;
  const options = { cwd, timeoutMs: 5000 };
  let mode = entry?.oldMode;
  if (entry && entry.newMode !== "160000" && mode === undefined) {
    // Not every record gives the base mode at the source path.
    const args = ["--literal-pathspecs", "ls-tree", "--format=%(objectmode)", base, "--", source];
    mode = (await runGit(args, options)).trim();
  }

  let result: FileDiff;
  if (status === "deleted") {
    // The selected base path is a leaf and the empty tree has no children.
    const emptyTree = (await runGit(["hash-object", "-t", "tree", "--stdin"], options)).trim();
    const diff = await gitPatch(cwd, base, emptyTree, "--", file);
    const old_content = mode === "160000" ? null : await getGitFileContent(cwd, basePath);
    result = { file, diff, old_content, new_content: "" };
  } else if (entry?.newMode === "160000" || mode === "160000") {
    // An added gitlink can replace a directory whose deleted children match the same pathspec.
    const filter = status === "added" ? ["--diff-filter=A"] : [];
    const diff = await gitPatch(cwd, base, ...filter, "--", file);
    result = { file, diff, old_content: null, new_content: null };
  } else {
    const blob = mode && mode !== "000000" && mode !== "040000" ? basePath : null;
    result = await readWorkingDiff(cwd, file, blob);
  }
  return result;
}
