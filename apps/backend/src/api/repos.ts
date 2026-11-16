/** Answers the operations in `shared/api/repos.ts`. */

import path from "path";
import fs from "fs";
import os from "os";
import { spawn, execFile, execFileSync, type ChildProcess } from "child_process";
import { promisify } from "util";
import * as api from "@shared/api/repos";
import type { ParsedInputOf } from "@shared/api/op";
import { uuidv7 } from "@shared/lib/uuid";
import {
  githubRepoSlug,
  httpsOrigin,
  normalizeRepoRef,
  parseGithubRepository,
} from "@shared/git-origin";
import type { BranchSummary, PRSummary } from "@shared/types/github";
import type { InspectedRepository, Repository } from "@shared/types/repository";
import type { RepositoryRow } from "../db/types";
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
import { defaultCloudOrgId } from "../services/agent/cloud/config";
import { listAccessibleRepos } from "../services/cloud-settings.service";
import * as githubRemote from "../services/github-remote";
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

/** The project's folder; refused in words for a project that is not on this computer. */
function requireFolder(repo: RepositoryRow): string {
  if (!repo.root_path) {
    throw new ConflictError(`${repo.name} is not on this computer: it has no folder here.`);
  }
  return repo.root_path;
}

/** One GitHub repository's identity, whatever form its address was written in. */
function originKey(origin: string): string {
  return normalizeRepoRef(httpsOrigin(origin));
}

/** The projects for one GitHub repository, in sidebar order. */
function projectsWithOrigin(db: ReturnType<typeof getDatabase>, origin: string): RepositoryRow[] {
  const key = originKey(origin);
  return (
    db
      .prepare(
        "SELECT * FROM repositories WHERE git_origin_url IS NOT NULL ORDER BY sort_order, name"
      )
      .all() as RepositoryRow[]
  ).filter((repo) => originKey(repo.git_origin_url!) === key);
}

/** The organization a cloud read acts in: the one named, else the default one. */
function organizationFor(organizationId: string | null | undefined): string | null {
  return organizationId ?? defaultCloudOrgId();
}

/**
 * Add a GitHub repository as a project with no folder here, or return the
 * project that already exists for it. Its default branch is asked of GitHub;
 * when GitHub will not say (private, no access yet) it is `main` until the next
 * branch read corrects it.
 */
export async function addCloudRepository(
  repository: string,
  organizationId?: string | null
): Promise<Repository> {
  const db = getDatabase();
  const slug = parseGithubRepository(repository);
  if (!slug) {
    throw new ValidationError(
      "Only GitHub repositories can be added here. Use owner/name or a github.com address."
    );
  }
  const origin = `https://github.com/${slug}`;
  const existing = projectsWithOrigin(db, origin)[0];
  if (existing) return existing;

  const branch =
    (await githubRemote.defaultBranch(slug, organizationFor(organizationId))) ?? "main";
  const repoId = uuidv7();
  const repo = db.transaction(() => {
    // Asked of GitHub meanwhile: another add may have won.
    const raced = projectsWithOrigin(db, origin)[0];
    if (raced) return raced;
    db.prepare(
      `INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order, git_origin_url)
       VALUES (?, ?, NULL, ?, ?, ?)`
    ).run(repoId, slug.split("/")[1], branch, getMaxRepositorySortOrder(db) + 1, origin);
    return getRepositoryById(db, repoId);
  })();
  if (!repo) throw new AppError(500, "Repository was not saved");
  invalidate(["workspaces"]);
  return repo;
}

/** The organization's reachable repositories, each with the project that exists for it here. */
async function listCloudRepositories(organizationId?: string | null) {
  const orgId = organizationFor(organizationId);
  if (!orgId) {
    throw new ConflictError("Sign in to Deus Cloud to see your organization's repositories.");
  }
  const { repos } = await listAccessibleRepos(orgId);
  const byOrigin = new Map<string, string>();
  for (const repo of getAllRepositories(getDatabase())) {
    if (!repo.git_origin_url) continue;
    const key = originKey(repo.git_origin_url);
    if (!byOrigin.has(key)) byOrigin.set(key, repo.id);
  }
  return {
    repositories: repos.map((slug) => ({
      slug,
      repoId: byOrigin.get(originKey(`https://github.com/${slug}`)) ?? null,
    })),
  };
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

async function inspectRepository(rootPath: string): Promise<InspectedRepository> {
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
    git_default_branch: await detectDefaultBranch(root),
    git_origin_url: getGitRemoteUrlSync(root),
  };
}

/** Register a folder as a project. Also what `POST /repos` answers with. */
export async function addRepository(rootPath: string): Promise<Repository> {
  const db = getDatabase();
  const inspected = await inspectRepository(rootPath);
  const repoId = uuidv7();

  const insert = db.transaction(() => {
    const existing = getRepositoryByRootPath(db, inspected.root_path);
    if (existing) throw new ConflictError("Repository already exists", existing);

    // The repository is already a project with no folder here: this folder
    // becomes its folder. Two folders of one repository stay two projects.
    const waiting = inspected.git_origin_url
      ? projectsWithOrigin(db, inspected.git_origin_url).find((repo) => !repo.root_path)
      : undefined;
    if (waiting) {
      db.prepare("UPDATE repositories SET root_path = ?, git_default_branch = ? WHERE id = ?").run(
        inspected.root_path,
        inspected.git_default_branch,
        waiting.id
      );
      return getRepositoryById(db, waiting.id);
    }

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
  invalidate(["workspaces"]);
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
  // The stored origin, else what git says now (a project with no folder always has one).
  const originUrl =
    repo.git_origin_url ?? (repo.root_path ? getGitRemoteUrlSync(repo.root_path) : null);
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
    { cwd: repo.root_path ?? undefined, timeoutMs: 10000 }
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

/**
 * A project with no folder here: GitHub's branches, default first. GitHub's
 * default branch replaces the row's when they differ (a project added while
 * GitHub would not say is `main` until now).
 */
async function listGithubBranches(
  repo: RepositoryRow,
  organizationId?: string | null
): Promise<{ branches: BranchSummary[] }> {
  const slug = repo.git_origin_url ? githubRepoSlug(repo.git_origin_url) : null;
  if (!slug) return { branches: [] };
  const found = await githubRemote.branches(slug, organizationFor(organizationId));
  if (found.defaultBranch && found.defaultBranch !== repo.git_default_branch) {
    getDatabase()
      .prepare("UPDATE repositories SET git_default_branch = ? WHERE id = ? AND root_path IS NULL")
      .run(found.defaultBranch, repo.id);
    invalidate(["workspaces"]);
  }
  return { branches: found.branches.map((name) => ({ name })) };
}

async function listRemoteBranches(
  repoId: string,
  organizationId?: string | null
): Promise<{ branches: BranchSummary[] }> {
  const repo = requireRepo(repoId);
  if (!repo.root_path) return listGithubBranches(repo, organizationId);
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
  // The clone's remote-tracking refs: `origin/<name>` where they show.
  return { branches: names.map((name) => ({ name, is_remote: true })) };
}

export default [
  handle(api.repos, () => getAllRepositories(getDatabase())),
  handle(api.repoEnvironmentFile, async ({ repoId }) => {
    // The local checkout is the only source: never another branch's file.
    const root = requireFolder(requireRepo(repoId));
    const project = readProjectFile(root);
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: root });
    return { project, branch: stdout.trim() || "detached HEAD" };
  }),
  handle(api.repoPrs, ({ repoId }) => listOpenPrs(repoId)),
  handle(api.repoBranches, ({ repoId, organizationId }) =>
    listRemoteBranches(repoId, organizationId)
  ),
  handle(api.cloudRepositories, ({ organizationId }) => listCloudRepositories(organizationId)),
  // An unknown repository or one without an origin is a status the composer
  // ignores, never a 404: it only acts on "needs_grant".
  handle(api.cloudRepoAccess, ({ repoId, organizationId, fresh }) =>
    resolveCloudRepoAccess(repoId, organizationId, { fresh })
  ),
  handle(api.recentProjects, () => ({ projects: listRecentProjects() })),
  handle(api.inspectRepo, ({ root_path }) => inspectRepository(root_path)),

  handle(api.addRepo, ({ root_path }) => addRepository(root_path)),
  handle(api.addCloudRepo, ({ repository, organizationId }) =>
    addCloudRepository(repository, organizationId)
  ),
  handle(api.saveRepoEnvironmentFile, ({ repoId, project }) => {
    writeProjectFile(requireFolder(requireRepo(repoId)), project);
  }),
  handle(api.gitClone, cloneRepository),
  handle(api.gitInit, initProject),
];
