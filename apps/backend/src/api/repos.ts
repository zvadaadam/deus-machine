/** Answers the operations in `shared/api/repos.ts`. */

import path from "path";
import fs from "fs";
import os from "os";
import { spawn, execFile, execFileSync, type ChildProcess } from "child_process";
import { promisify } from "util";
import * as api from "@shared/api/repos";
import type { ParsedInputOf } from "@shared/api/op";
import { uuidv7 } from "@shared/lib/uuid";
import type { BranchSummary, PRSummary } from "@shared/types/github";
import type { InspectedRepository, Repository } from "@shared/types/repository";
import { getDatabase } from "../lib/database";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { getGitRemoteUrlSync } from "../lib/git-remotes";
import {
  getAllRepositories,
  getMaxRepositorySortOrder,
  getRepositoryById,
  getRepositoryByRootPath,
} from "../db";
import { resolveCloudRepoAccess } from "../services/cloud-workspace-init.service";
import { detectDefaultBranch } from "../services/git.service";
import { parseGitHubRepo, runGh } from "../services/gh.service";
import { readProjectFile, writeProjectFile } from "../services/project-environment.service";
import { invalidate } from "../services/query-engine";
import { listRecentProjects } from "../services/recent-projects.service";
import { publish } from "../services/streams";
import { handle } from "./registry";

const execFileAsync = promisify(execFile);

const SAFE_GIT_URL = /^https?:\/\/[^\s;|&`$()]+$/;

/** One row of `gh pr list --json number,title,headRefName,baseRefName,url,isDraft`. */
interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  isDraft: boolean;
}

function requireRepo(id: string) {
  const repo = getRepositoryById(getDatabase(), id);
  if (!repo) throw new NotFoundError("Repository not found");
  return repo;
}

/** Expand a leading `~` to the home directory: Node's path functions treat it as a literal. */
function expandTilde(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Where a clone or a new project goes: the parent folder is created, and a
 * path that leaves the home directory (through a symlink too) is refused.
 */
function resolveTargetPath(targetPath: string): string {
  const resolvedPath = path.resolve(expandTilde(targetPath));
  const parentDir = path.dirname(resolvedPath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    throw new AppError(500, `Cannot create parent directory: ${(err as Error).message}`);
  }

  const realHome = fs.realpathSync(os.homedir());
  const realParent = fs.realpathSync(parentDir);
  const candidatePath = path.join(realParent, path.basename(resolvedPath));
  if (!candidatePath.startsWith(realHome + path.sep) && candidatePath !== realHome) {
    throw new ValidationError("Target path must be within the home directory");
  }
  return resolvedPath;
}

function inspectRepository(rootPath: string): InspectedRepository {
  let root = expandTilde(rootPath);

  try {
    root = fs.realpathSync(root);
  } catch {
    throw new ValidationError("Path does not exist or is inaccessible");
  }

  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new AppError(403, "Path is not accessible (permission denied)");
  }

  if (!fs.statSync(root).isDirectory()) throw new ValidationError("Path is not a directory");

  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      // The first git spawn on a cold macOS CI runner can take more than 2s
      // (Gatekeeper scans the packaged app): robust matters more than snappy.
      timeout: 10_000,
    })
      .toString()
      .trim();
  } catch {
    throw new ValidationError("Path is not a git repository");
  }

  return {
    root_path: root,
    name: path.basename(root),
    git_default_branch: detectDefaultBranch(root),
    git_origin_url: getGitRemoteUrlSync(root),
  };
}

/** Register a folder as a project. Also what `POST /repos` answers with. */
export function addRepository(rootPath: string): Repository {
  const db = getDatabase();
  const inspected = inspectRepository(rootPath);
  const repoId = uuidv7();

  const insert = db.transaction(() => {
    const existing = getRepositoryByRootPath(db, inspected.root_path);
    if (existing) throw new ConflictError("Repository already exists", existing);

    const sortOrder = getMaxRepositorySortOrder(db) + 1;
    db.prepare(
      `INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      repoId,
      inspected.name,
      inspected.root_path,
      inspected.git_default_branch,
      sortOrder,
      inspected.git_origin_url
    );
    return getRepositoryById(db, repoId);
  });

  const repo = insert();
  if (!repo) throw new AppError(500, "Repository was not saved");
  // "workspaces" carries every repository summary (the sidebar's project
  // list), so other connected clients only see the new repo through it.
  invalidate(["workspaces", "stats"]);
  return repo;
}

const pushCloneLine = (line: string) => publish(api.gitProgress, { operation: "clone" }, { line });
const pushInitLine = (line: string) => publish(api.gitProgress, { operation: "init" }, { line });

/**
 * Forward git's stderr progress to a callback one line at a time; git rewrites
 * a line in place with `\r`. `flush()` returns whatever was left unterminated.
 */
function pipeGitStderr(
  proc: ChildProcess,
  onLine: (line: string) => void
): { flush: () => string } {
  let buffer = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/[\r\n]+/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  });
  return {
    flush() {
      const remaining = buffer.trim();
      buffer = "";
      return remaining;
    },
  };
}

async function cloneRepository({
  url,
  targetPath,
}: ParsedInputOf<typeof api.gitClone>): Promise<{ path: string }> {
  if (!SAFE_GIT_URL.test(url)) throw new ValidationError("Invalid repository URL format");

  const resolvedPath = resolveTargetPath(targetPath);
  if (fs.existsSync(resolvedPath)) {
    if (fs.existsSync(path.join(resolvedPath, ".git"))) {
      throw new ConflictError("Target already contains a git repository");
    }
    throw new ConflictError("Target directory already exists and is not a git repository");
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", "--progress", url, resolvedPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    const { flush } = pipeGitStderr(proc, pushCloneLine);

    proc.on("close", (code) => {
      const remaining = flush();
      if (remaining) pushCloneLine(remaining);
      if (code === 0) {
        pushCloneLine("Clone complete.");
        resolve({ path: resolvedPath });
      } else {
        reject(new AppError(500, remaining || `git clone exited with code ${code}`));
      }
    });
    proc.on("error", (err) => reject(new AppError(500, `Failed to start git: ${err.message}`)));
  });
}

async function initProject({
  projectName,
  targetPath,
  templateType,
  templateUrl,
}: ParsedInputOf<typeof api.gitInit>): Promise<{ path: string; githubUrl: string | null }> {
  const resolvedPath = resolveTargetPath(targetPath);
  if (fs.existsSync(resolvedPath)) throw new ConflictError("Target directory already exists");

  // The contract refuses a github template without its URL.
  if (templateType === "github" && templateUrl) {
    pushInitLine("Downloading template...");
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("git", ["clone", "--depth", "1", templateUrl, resolvedPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      const { flush } = pipeGitStderr(proc, pushInitLine);

      proc.on("close", (code) => {
        const remaining = flush();
        if (remaining) pushInitLine(remaining);
        if (code === 0) resolve();
        else reject(new Error(remaining || `git clone exited with code ${code}`));
      });
      proc.on("error", (err) => reject(err));
    });

    // The template's history is not this project's: start a fresh repository.
    pushInitLine("Initializing as new project...");
    fs.rmSync(path.join(resolvedPath, ".git"), { recursive: true, force: true });
    await execFileAsync("git", ["init"], { cwd: resolvedPath, timeout: 5000 });
  } else {
    pushInitLine("Creating project directory...");
    fs.mkdirSync(resolvedPath, { recursive: true });

    pushInitLine("Initializing git repository...");
    await execFileAsync("git", ["init"], { cwd: resolvedPath, timeout: 5000 });

    fs.writeFileSync(path.join(resolvedPath, "README.md"), `# ${projectName}\n`);
  }

  pushInitLine("Creating initial commit...");
  await execFileAsync("git", ["add", "."], { cwd: resolvedPath, timeout: 5000 });
  await execFileAsync("git", ["commit", "-m", "Initial commit"], {
    cwd: resolvedPath,
    timeout: 5000,
  });

  // A GitHub repository is a bonus: the project exists without the gh CLI or a
  // login. Created without --push, then pushed, so a failed push (GitHub can
  // take a moment to see a new repository) does not lose the URL.
  let githubUrl: string | null = null;
  try {
    pushInitLine("Creating GitHub repository...");
    const ghResult = await runGh(
      ["repo", "create", projectName, "--private", "--source", resolvedPath, "--remote", "origin"],
      { cwd: resolvedPath, timeoutMs: 30_000 }
    );
    if (ghResult.success && ghResult.stdout) {
      const urlMatch = ghResult.stdout.match(/https:\/\/github\.com\/[^\s]+/);
      if (urlMatch) {
        githubUrl = urlMatch[0];
        pushInitLine(`GitHub repository created: ${githubUrl}`);
      }
    } else if (!ghResult.success) {
      console.warn("[repos/init] gh repo create failed:", ghResult.error, ghResult.message);
      pushInitLine(`GitHub: ${ghResult.message || ghResult.error}`);
    }

    if (githubUrl) {
      try {
        pushInitLine("Pushing initial commit...");
        await execFileAsync("git", ["push", "-u", "origin", "HEAD"], {
          cwd: resolvedPath,
          timeout: 15_000,
        });
      } catch (pushErr) {
        console.warn("[repos/init] git push failed (repo still created):", pushErr);
        pushInitLine("Push failed — you can push manually later.");
      }
    }
  } catch (err) {
    console.warn("[repos/init] gh repo create error:", err);
    pushInitLine("Skipped GitHub — repository created locally.");
  }

  pushInitLine("Project created successfully.");
  return { path: resolvedPath, githubUrl };
}

async function listOpenPrs(repoId: string): Promise<PRSummary[]> {
  const repo = requireRepo(repoId);
  // The stored origin, else what git says now.
  const originUrl = repo.git_origin_url ?? getGitRemoteUrlSync(repo.root_path);
  const nwo = originUrl ? parseGitHubRepo(originUrl) : null;
  if (!nwo) return [];

  const result = await runGh(
    [
      "pr",
      "list",
      "--repo",
      nwo,
      "--state",
      "open",
      "--json",
      "number,title,headRefName,baseRefName,url,isDraft",
      "--limit",
      "50",
    ],
    { cwd: repo.root_path, timeoutMs: 10000 }
  );
  if (!result.success) return [];

  let prs: GhPullRequest[];
  try {
    prs = JSON.parse(result.stdout || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(prs)) return [];

  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    baseBranch: pr.baseRefName,
    url: pr.url,
    isDraft: pr.isDraft === true,
  }));
}

async function listRemoteBranches(repoId: string): Promise<{ branches: BranchSummary[] }> {
  const repo = requireRepo(repoId);
  let output: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "refs/remotes/origin/",
        "--count=100",
      ],
      { cwd: repo.root_path, encoding: "utf-8", timeout: 5000 }
    );
    output = stdout;
  } catch {
    return { branches: [] };
  }

  const names = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter((name) => name !== "HEAD");
  return { branches: names.map((name) => ({ name })) };
}

export default [
  handle(api.repos, () => getAllRepositories(getDatabase())),
  handle(api.repoEnvironmentFile, async ({ repoId }) => {
    // The local checkout is the only source: never another branch's file.
    const repo = requireRepo(repoId);
    const project = readProjectFile(repo.root_path);
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: repo.root_path,
    });
    return { project, branch: stdout.trim() || "detached HEAD" };
  }),
  handle(api.repoPrs, ({ repoId }) => listOpenPrs(repoId)),
  handle(api.repoBranches, ({ repoId }) => listRemoteBranches(repoId)),
  // An unknown repository or one without an origin is a status the composer
  // ignores, never a 404: it only acts on "needs_grant".
  handle(api.cloudRepoAccess, ({ repoId }) => resolveCloudRepoAccess(repoId)),
  handle(api.recentProjects, () => ({ projects: listRecentProjects() })),
  handle(api.inspectRepo, ({ root_path }) => inspectRepository(root_path)),

  handle(api.addRepo, ({ root_path }) => addRepository(root_path)),
  handle(api.saveRepoEnvironmentFile, ({ repoId, project }) => {
    writeProjectFile(requireRepo(repoId).root_path, project);
  }),
  handle(api.gitClone, cloneRepository),
  handle(api.gitInit, initProject),
];
