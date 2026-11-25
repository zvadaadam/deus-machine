import { promisify } from "util";
import type { PRStatus } from "@shared/types/github";
import { execFile } from "child_process";
import { getErrorMessage, isExecError } from "@shared/lib/errors";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { extendCliPath, resolveCliExecutable } from "@shared/lib/cli-path";
import { parseGitHubRepo } from "@shared/lib/github";
import { getGitRemoteUrl } from "../lib/git-remotes";
import { runGit } from "@shared/lib/git-process";
export { parseGitHubRepo };

const execFileAsync = promisify(execFile);
export function ghChildEnv(): NodeJS.ProcessEnv {
  return createBackendChildEnv({
    PATH: extendCliPath(process.env.PATH),
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  });
}

// Helper: run gh CLI command with timeout, explicit error classification
export async function runGh(
  args: string[],
  options: { cwd?: string; timeoutMs?: number }
): Promise<
  | { success: true; stdout: string }
  | {
      success: false;
      error: NonNullable<PRStatus["error"]>;
      message: string;
    }
> {
  try {
    const { stdout } = await execFileAsync(resolveCliExecutable("gh"), args, {
      cwd: options.cwd,
      encoding: "utf-8",
      timeout: options.timeoutMs ?? 5000,
      env: ghChildEnv(),
    });
    return { success: true, stdout: stdout.trim() };
  } catch (err: unknown) {
    if (isExecError(err)) {
      if (err.code === "ENOENT")
        return {
          success: false,
          error: "gh_not_installed",
          message: "GitHub CLI (gh) is not installed",
        };
      if (err.killed)
        return { success: false, error: "timeout", message: "GitHub CLI command timed out" };
      if (err.code === 4)
        return {
          success: false,
          error: "gh_not_authenticated",
          message: "GitHub CLI is not authenticated",
        };
      return {
        success: false,
        error: "unknown",
        message: err.stderr || err.message || "Failed to run gh CLI",
      };
    }
    return { success: false, error: "unknown", message: getErrorMessage(err) };
  }
}

// GitHub Check Suite conclusions that indicate a non-passing terminal state.
// Full GraphQL enum: ACTION_REQUIRED, CANCELLED, FAILURE, NEUTRAL, SKIPPED,
// STALE, STARTUP_FAILURE, SUCCESS, TIMED_OUT.
// NEUTRAL/SKIPPED are intentionally non-blocking (count as passing).
// STALE means re-run is needed (count as pending below).
export const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "CANCELLED",
]);

// CheckRun `status` values that indicate the check hasn't completed yet.
// Note: CheckRun uses `status` field, StatusContext uses `state` field.
export const PENDING_STATUSES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "WAITING",
  "REQUESTED",
]);

/**
 * Classify a single GitHub check (CheckRun or StatusContext) into a uniform status.
 * GitHub's statusCheckRollup contains two object types:
 *   - CheckRun (__typename: "CheckRun"): uses `conclusion` + `status`
 *   - StatusContext (__typename: "StatusContext"): uses `state`
 */
export function classifyCheck(check: any): "passing" | "failing" | "pending" {
  if (check.__typename === "StatusContext") {
    if (check.state === "FAILURE" || check.state === "ERROR") return "failing";
    if (check.state === "PENDING" || check.state === "EXPECTED") return "pending";
    return "passing";
  }
  // CheckRun
  if (FAILING_CONCLUSIONS.has(check.conclusion)) return "failing";
  if (
    check.conclusion === "STALE" ||
    check.conclusion == null ||
    PENDING_STATUSES.has(check.status)
  )
    return "pending";
  return "passing";
}

/** What a PR lookup answers: the shape clients read (shared/types/github.ts). */
export type PrStatusResponse = PRStatus;

/**
 * Resolve the PR status for a workspace by inspecting HEAD branch
 * and querying GitHub via `gh pr list`. Handles fork detection
 * (origin vs upstream remotes) and prioritizes open > merged > closed PRs.
 */
export async function getPrStatus(workspacePath: string): Promise<PrStatusResponse> {
  // Resolve current branch name
  let headBranch: string;
  try {
    const stdout = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspacePath,
      timeoutMs: 3000,
    });
    headBranch = stdout.trim();
  } catch {
    return { has_pr: false, conclusive: false, error: null };
  }

  if (!headBranch || headBranch === "HEAD")
    return { has_pr: false, conclusive: false, error: null };

  // Resolve origin and upstream remotes for fork support
  const originUrl = await getGitRemoteUrl(workspacePath, "origin");
  const upstreamUrl = await getGitRemoteUrl(workspacePath, "upstream");

  // A local-only project has no PR to look up. Letting gh infer a repository
  // here turns its "no git remotes found" error into a false network warning.
  if (!originUrl && !upstreamUrl) {
    const remotes = await runGit(["remote"], { cwd: workspacePath, timeoutMs: 3000 }).catch(
      () => undefined
    );
    if (remotes?.trim() === "") {
      return { has_pr: false, conclusive: false, no_remote: true, error: null };
    }
    // A custom remote name (or an inconclusive check) still lets gh resolve it.
  }

  const isFork = upstreamUrl != null && originUrl != null && upstreamUrl !== originUrl;

  // Build list of attempts: try upstream first (for forks), then origin.
  // Use plain branch name — gh pr list --head does NOT support "owner:branch" syntax.
  // The workspace branch is the identity here; agents may push PRs from org-owned
  // branches or automation accounts, so author filtering is intentionally avoided.
  const attempts: { repoArg: string | null; headArg: string }[] = [];
  if (isFork) attempts.push({ repoArg: upstreamUrl, headArg: headBranch });
  attempts.push({ repoArg: originUrl, headArg: headBranch });

  return queryPrStatus(attempts, workspacePath);
}

/**
 * PR status for a branch known only by name + remote — cloud workspaces have
 * no local checkout, but the DB carries the workspace branch and the repo's
 * origin URL, which is all `gh pr list --repo` needs.
 */
export async function getPrStatusForRemoteBranch(
  originUrl: string,
  headBranch: string
): Promise<PrStatusResponse> {
  if (!headBranch) return { has_pr: false, conclusive: false, error: null };
  return queryPrStatus([{ repoArg: originUrl, headArg: headBranch }], undefined);
}

/** The shared gh lookup: try each repo in order, first PR found wins. */
async function queryPrStatus(
  attempts: { repoArg: string | null; headArg: string }[],
  workspacePath: string | undefined
): Promise<PrStatusResponse> {
  let lookupFailed = false;

  for (const { repoArg, headArg } of attempts) {
    const args = [
      "pr",
      "list",
      "--head",
      headArg,
      "--state",
      "all",
      "--json",
      "number,title,url,state,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft",
    ];
    if (repoArg) {
      args.push("--repo", parseGitHubRepo(repoArg) ?? repoArg);
    }

    const result = await runGh(args, { cwd: workspacePath });
    if (!result.success) {
      if (result.error !== "unknown") {
        return { has_pr: false, conclusive: false, error: result.error };
      }
      lookupFailed = true;
      continue;
    }

    let prs: any[];
    try {
      prs = JSON.parse(result.stdout);
    } catch {
      lookupFailed = true;
      continue;
    }
    if (!Array.isArray(prs)) {
      lookupFailed = true;
      continue;
    }

    // Priority: OPEN > MERGED > CLOSED. Open PRs are actionable,
    // merged PRs show archive, closed PRs show a non-actionable status.
    const openPr = prs.find((pr: any) => pr.state?.toUpperCase() === "OPEN");
    const mergedPr = prs.find((pr: any) => pr.state?.toUpperCase() === "MERGED");
    const closedPr = prs.find((pr: any) => pr.state?.toUpperCase() === "CLOSED");
    const pr = openPr ?? mergedPr ?? closedPr;

    if (pr) {
      const upperState = pr.state?.toUpperCase();
      const state: "open" | "merged" | "closed" =
        upperState === "MERGED" ? "merged" : upperState === "CLOSED" ? "closed" : "open";
      const identity = {
        has_pr: true,
        conclusive: true,
        pr_number: pr.number,
        pr_title: pr.title,
        pr_url: pr.url,
        base_branch: pr.baseRefName,
        pr_state: state,
        is_draft: pr.isDraft === true,
        error: null,
      };

      // Closed PRs are terminal — no CI or merge status is relevant
      if (state === "closed") {
        return {
          ...identity,
          merge_status: "blocked",
          has_conflicts: false,
          ci_status: "unknown",
          review_status: "none",
        };
      }

      let mergeStatus: "ready" | "blocked" | "merged" = "blocked";
      if (state === "merged") mergeStatus = "merged";
      else if (pr.mergeable === "MERGEABLE") mergeStatus = "ready";

      const rawChecks: any[] = pr.statusCheckRollup ?? [];
      let ciStatus: "passing" | "failing" | "pending" | "unknown" = "unknown";
      let checksDone = 0;
      const checksTotal = rawChecks.length;
      const checkDetails = rawChecks.map((check: any) => ({
        name: check.name || check.context || "Unknown",
        status: classifyCheck(check),
        url: check.detailsUrl || check.targetUrl || undefined,
      }));
      if (rawChecks.length > 0) {
        const statuses = checkDetails.map((c: any) => c.status);
        checksDone = statuses.filter((s: string) => s !== "pending").length;
        if (statuses.includes("failing")) ciStatus = "failing";
        else if (statuses.includes("pending")) ciStatus = "pending";
        else ciStatus = "passing";
      }

      // Map reviewDecision from GitHub GraphQL enum
      const reviewMap: Record<
        string,
        "approved" | "changes_requested" | "review_required" | "none"
      > = {
        APPROVED: "approved",
        CHANGES_REQUESTED: "changes_requested",
        REVIEW_REQUIRED: "review_required",
      };
      const reviewStatus = reviewMap[pr.reviewDecision ?? ""] ?? "none";

      return {
        ...identity,
        merge_status: mergeStatus,
        has_conflicts: pr.mergeStateStatus === "DIRTY",
        ci_status: ciStatus,
        checks_done: checksDone,
        checks_total: checksTotal,
        checks: checkDetails,
        review_status: reviewStatus,
      };
    }
  }

  // A fork can have a PR in either repository.
  return { has_pr: false, conclusive: !lookupFailed, error: lookupFailed ? "unknown" : null };
}
