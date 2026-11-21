/**
 * A local workspace from "create" to "ready", and back from a failure.
 *
 * Starting runs in the background, in order:
 *
 *   fetch     origin's latest for the source branch. Never fatal: without it
 *             the workspace starts from the copy already on this computer, and
 *             the row says why (`init_fetch_issue`).
 *   worktree  `git worktree add` on a new branch. Fatal.
 *   session   the first chat, and `state = 'ready'`. Fatal.
 * The project's setup runs alongside the first turn and reports through setup_status.
 *
 * Each stage writes its name to `init_stage` and pushes the workspace list, so
 * the desktop, the web app and a phone all follow the same progress.
 *
 * A fatal failure removes what the attempt made and leaves the row in `error`
 * with a plain reason (`error_message`) and the tool's own words
 * (`error_detail`). From there it is started again in place
 * (`retryWorkspaceInit`: same row, so whatever waits on its id still does) or
 * deleted (`deleteFailedWorkspace`). A backend that stops mid-start leaves a
 * row nothing is working on; `failInterruptedWorkspaces` turns those into the
 * same failure at the next start.
 */
import fs from "fs";
import path from "path";
import type { InitFetchIssue } from "@shared/enums";
import { getDatabase } from "../lib/database";
import { GitError, runGit } from "../lib/git-process";
import { processGroupsStopped } from "../lib/process-groups";
import {
  advanceLocalStage,
  failStart,
  finishLocalStart,
  recordFetchOutcome,
} from "./workspace-lifecycle";
import { generateUniqueName } from "./workspace.service";

const FETCH_TIMEOUT_MS = 30_000;
const WORKTREE_TIMEOUT_MS = 120_000;

export type Stage = "fetch" | "worktree" | "session";

/** From these stages on, the folder and branch under the workspace's name are the attempt's own. */
export const OWNS_WORKTREE: ReadonlySet<string> = new Set(["worktree", "session", "setup"]); // Older interrupted starts can be in setup.

export interface InitContext {
  workspaceId: string;
  repoRootPath: string;
  workspacePath: string;
  /** The workspace's own new branch. */
  branchName: string;
  /** The branch it starts from: origin's copy when there is one, else this computer's. */
  sourceBranch: string;
  repoOriginUrl?: string | null;
}

interface Failure {
  message: string;
  detail: string | null;
}

const succeeds = (command: Promise<unknown>): Promise<boolean> =>
  command.then(
    () => true,
    () => false
  );

// ─── Names ──────────────────────────────────────────────────────

async function branchPrefix(repoRootPath: string): Promise<string> {
  const user = await runGit(["config", "user.name"], { cwd: repoRootPath }).catch(() => "");
  return (
    user
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-") || "workspace"
  );
}

/**
 * A name free in the database, on disk and among the repository's branches.
 * The last two outlive a reset database, and `git worktree add` refuses both.
 */
export async function pickWorkspaceName(
  repoRootPath: string
): Promise<{ slug: string; branchName: string }> {
  const prefix = await branchPrefix(repoRootPath);
  const listed = await runGit(
    // Not `:short`: a branch a tag shares its name with is shortened to `heads/<name>`.
    ["for-each-ref", "--format=%(refname:lstrip=2)", `refs/heads/${prefix}/`],
    { cwd: repoRootPath }
  ).catch(() => "");
  const branches = new Set(listed.split("\n"));
  const slug = generateUniqueName(
    getDatabase(),
    (name) =>
      branches.has(`${prefix}/${name}`) || fs.existsSync(path.join(repoRootPath, ".deus", name))
  );
  return { slug, branchName: `${prefix}/${slug}` };
}

/**
 * Called before the worktree stage, so that everything found under the name
 * from then on was made by this attempt and is safe to remove. A name that is
 * taken (a cleanup that failed, something made by hand) is not reused: the
 * workspace takes a new one.
 */
async function claimName(ctx: InitContext): Promise<InitContext> {
  const taken =
    fs.existsSync(ctx.workspacePath) ||
    (await succeeds(
      runGit(["show-ref", "--verify", "--quiet", `refs/heads/${ctx.branchName}`], {
        cwd: ctx.repoRootPath,
      })
    ));
  if (!taken) return ctx;
  const { slug, branchName } = await pickWorkspaceName(ctx.repoRootPath);
  getDatabase()
    .prepare("UPDATE workspaces SET slug = ?, git_branch = ? WHERE id = ?")
    .run(slug, branchName, ctx.workspaceId);
  return { ...ctx, branchName, workspacePath: path.join(ctx.repoRootPath, ".deus", slug) };
}

// ─── Stages ─────────────────────────────────────────────────────

/** Why a fetch failed, or null when the failure says nothing is wrong (the branch is only here). */
export function fetchIssue(error: unknown): InitFetchIssue | null {
  if (!(error instanceof GitError)) return "failed";
  if (error.timedOut) return "offline";
  const said = error.stderr;
  if (/couldn't find remote ref/i.test(said)) return null;
  if (
    /could not resolve host|failed to connect|couldn't connect|connection refused|connection timed out|operation timed out|connection reset|network is unreachable|no route to host/i.test(
      said
    )
  )
    return "offline";
  // A private repository answers "not found" to someone it does not know.
  if (
    /could not read username|terminal prompts disabled|authentication failed|permission denied|invalid credentials|device not configured|repository .*not found|access denied|returned error: 40[13]/i.test(
      said
    )
  )
    return "auth";
  return "failed";
}

/**
 * Workspaces branch from origin's copy of the source branch, not this
 * computer's: diffs are measured against `origin/<branch>`, so a workspace cut
 * from a stale local branch shows every commit since as its own change. Fetch
 * first so the workspace starts at the latest commit and its diff starts
 * empty. When origin cannot be reached the workspace still starts, from
 * whatever is here, and says so.
 */
async function refreshSource(
  ctx: InitContext
): Promise<{ base: string; issue: InitFetchIssue | null }> {
  const cwd = ctx.repoRootPath;
  let issue: InitFetchIssue | null = null;
  if (await succeeds(runGit(["remote", "get-url", "origin"], { cwd }))) {
    try {
      // Into origin's ref by name: a clone that tracks only some branches (a
      // `--single-branch` or shallow one) would not update it otherwise.
      const branch = ctx.sourceBranch;
      await runGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        cwd,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    } catch (err) {
      issue = fetchIssue(err);
      console.warn(
        `[WORKSPACE] Could not fetch origin/${ctx.sourceBranch} (${issue ?? "not on origin"}): ${err instanceof Error ? err.message : err}`
      );
    }
  }
  const onOrigin = await succeeds(
    runGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${ctx.sourceBranch}`], { cwd })
  );
  return { base: onOrigin ? `origin/${ctx.sourceBranch}` : ctx.sourceBranch, issue };
}

/**
 * Workspaces are worktrees inside the repository (`.deus/<name>`). Unless
 * something ignores them, they show up in the main checkout's `git status`,
 * and `git add -A` there stages each one as an embedded repository. Hide them
 * through the repository's local exclude file, which is never committed;
 * `.deus/environment.json` stays visible so it can still be shared.
 */
export async function excludeWorkspacesFromRepo(
  repoRootPath: string,
  workspacePath: string
): Promise<void> {
  const cwd = repoRootPath;
  // Already ignored: .gitignore, a global exclude or an earlier workspace.
  if (
    await succeeds(
      runGit(["check-ignore", "-q", path.relative(repoRootPath, workspacePath)], { cwd })
    )
  )
    return;
  const excludeFile = path.resolve(
    repoRootPath,
    (await runGit(["rev-parse", "--git-path", "info/exclude"], { cwd })).trim()
  );
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.appendFileSync(
    excludeFile,
    "\n# Deus workspaces (local worktrees)\n/.deus/*\n!/.deus/environment.json\n"
  );
}

/** Local secrets are not in git; the setup script that follows usually needs them. */
function copyLocalEnvFiles(ctx: InitContext): void {
  for (const name of [".env", ".env.local"]) {
    const from = path.join(ctx.repoRootPath, name);
    const to = path.join(ctx.workspacePath, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.copyFileSync(from, to);
    } catch (err) {
      console.warn(`[WORKSPACE] Failed to copy ${name}:`, err);
    }
  }
}

async function createWorktree(ctx: InitContext, base: string): Promise<void> {
  await runGit(["worktree", "add", "-b", ctx.branchName, ctx.workspacePath, base], {
    cwd: ctx.repoRootPath,
    timeoutMs: WORKTREE_TIMEOUT_MS,
  });
  await excludeWorkspacesFromRepo(ctx.repoRootPath, ctx.workspacePath).catch((err) => {
    console.warn("[WORKSPACE] Could not hide .deus workspaces from git status:", err);
  });
  copyLocalEnvFiles(ctx);
}

/**
 * Remove a workspace's folder, git's record of it and its branch, in whatever
 * state a stopped `git worktree add` left them. Each step is a no-op when
 * there is nothing for it to do.
 */
export async function removeWorktree(
  repoRootPath: string,
  workspacePath: string,
  branchName: string
): Promise<void> {
  const cwd = repoRootPath;
  // Forced twice: a worktree cut short while being made is still locked
  // ("initializing"), which one --force and `prune` both leave alone.
  await runGit(["worktree", "remove", "--force", "--force", workspacePath], {
    cwd,
    timeoutMs: 30_000,
  }).catch(() => {});
  // A folder git has no record of, left by a checkout that was stopped.
  await fs.promises.rm(workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await runGit(["worktree", "prune"], { cwd }).catch(() => {});
  await runGit(["branch", "-D", branchName], { cwd }).catch(() => {});
}

// ─── Failure ────────────────────────────────────────────────────

function describeFailure(stage: Stage, error: unknown, ctx: InitContext): Failure {
  const detail = error instanceof Error ? error.message : String(error);
  if (!fs.existsSync(ctx.repoRootPath))
    return {
      message: `The project folder is missing: ${ctx.repoRootPath}. Put it back, or add the project again from where it is now.`,
      detail,
    };
  if (stage === "session")
    return { message: "The workspace was created, but its chat could not be opened.", detail };
  if (error instanceof GitError) {
    const said = error.stderr;
    if (error.timedOut)
      return {
        message: `Copying the project took more than ${WORKTREE_TIMEOUT_MS / 60_000} minutes, so it was stopped.`,
        detail,
      };
    if (/invalid reference|not a valid object name|unknown revision/i.test(said))
      return {
        message: `The branch "${ctx.sourceBranch}" does not exist in this project.`,
        detail,
      };
    if (/not a git repository/i.test(said))
      return {
        message: `This folder is not a Git repository any more: ${ctx.repoRootPath}`,
        detail,
      };
    if (/no space left on device/i.test(said))
      return { message: "The disk is full. Free some space, then try again.", detail };
    if (/permission denied|operation not permitted/i.test(said))
      return {
        message: `Deus is not allowed to write to ${path.dirname(ctx.workspacePath)}. Check the folder's permissions.`,
        detail,
      };
    if (!said) return { message: "Git is not installed, or Deus could not run it.", detail };
  }
  return { message: "Git could not make this workspace's copy of the project.", detail };
}

/** Workspaces this process is starting right now. */
const starting = new Set<string>();

export async function initializeWorkspace(initial: InitContext): Promise<void> {
  if (starting.has(initial.workspaceId)) return;
  starting.add(initial.workspaceId);
  let ctx = initial;
  let stage: Stage = "fetch";
  try {
    advanceLocalStage(ctx.workspaceId, stage);
    const source = await refreshSource(ctx);
    recordFetchOutcome(ctx.workspaceId, source.issue);
    ctx = await claimName(ctx);

    stage = "worktree";
    advanceLocalStage(ctx.workspaceId, stage);
    await createWorktree(ctx, source.base);

    if (processGroupsStopped()) return;
    stage = "session";
    advanceLocalStage(ctx.workspaceId, stage);
    finishLocalStart(ctx);
  } catch (err) {
    // Deus is closing and stopped what this was running: the row stays as it
    // is, and the next start fails it as interrupted (failInterruptedWorkspaces).
    if (processGroupsStopped()) return;
    console.error(
      `[WORKSPACE] Stage "${stage}" failed for ${ctx.workspaceId}: ${err instanceof Error ? err.message : err}`
    );
    if (OWNS_WORKTREE.has(stage)) {
      await removeWorktree(ctx.repoRootPath, ctx.workspacePath, ctx.branchName).catch((e) =>
        console.warn(`[WORKSPACE] Could not remove what ${ctx.workspaceId} left behind:`, e)
      );
    }
    try {
      failStart(ctx.workspaceId, stage, describeFailure(stage, err, ctx));
    } catch (e) {
      console.error(`[WORKSPACE] Could not record the failure of ${ctx.workspaceId}:`, e);
    }
  } finally {
    starting.delete(ctx.workspaceId);
  }
}
