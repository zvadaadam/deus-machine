import { promisify } from "util";
import { execFile } from "child_process";
import { getErrorMessage, isExecError } from "@shared/lib/errors";
import { parseGitHubRepo } from "@shared/lib/github";
export { parseGitHubRepo };

const execFileAsync = promisify(execFile);

// Helper: run gh CLI command with timeout, explicit error classification
export async function runGh(
  args: string[],
  options: { cwd: string; timeoutMs?: number }
): Promise<
  | { success: true; stdout: string }
  | {
      success: false;
      error: "gh_not_installed" | "gh_not_authenticated" | "timeout" | "unknown";
      message: string;
    }
> {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      cwd: options.cwd,
      encoding: "utf-8",
      timeout: options.timeoutMs ?? 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
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
      const output = `${err.stderr ?? ""} ${err.stdout ?? ""}`.toLowerCase();
      if (output.includes("gh auth login") || output.includes("not logged into any github hosts"))
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

export interface PrStatusResponse {
  has_pr: boolean;
  pr_number?: number;
  pr_title?: string;
  pr_url?: string;
  pr_state?: "open" | "merged" | "closed";
  merge_status?: "ready" | "blocked" | "merged";
  is_draft?: boolean;
  has_conflicts?: boolean;
  ci_status?: "passing" | "failing" | "pending" | "unknown";
  checks_done?: number;
  checks_total?: number;
  checks?: Array<{ name: string; status: string; url?: string }>;
  review_status?: "approved" | "changes_requested" | "review_required" | "none";
  error: string | null;
}

/**
 * Resolve the PR status for a workspace by inspecting HEAD branch
 * and querying GitHub via `gh pr list`. Handles fork detection
 * (origin vs upstream remotes) and prioritizes open > merged > closed PRs.
 */
export async function getPrStatus(workspacePath: string): Promise<PrStatusResponse> {
  // Resolve current branch name
  let headBranch: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 3000,
    });
    headBranch = stdout.trim();
  } catch {
    return { has_pr: false, error: null };
  }

  if (!headBranch || headBranch === "HEAD") return { has_pr: false, error: null };

  // Resolve origin and upstream remotes for fork support
  let originUrl: string | null = null;
  let upstreamUrl: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 2000,
    });
    originUrl = stdout.trim() || null;
  } catch {}
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "upstream"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 2000,
    });
    upstreamUrl = stdout.trim() || null;
  } catch {}

  const isFork = upstreamUrl != null && originUrl != null && upstreamUrl !== originUrl;

  // Build list of attempts: try upstream first (for forks), then origin.
  // Use plain branch name — gh pr list --head does NOT support "owner:branch" syntax.
  // The --author @me flag already narrows results to the current user's PRs.
  const attempts: { repoArg: string | null; headArg: string }[] = [];
  if (isFork) attempts.push({ repoArg: upstreamUrl, headArg: headBranch });
  attempts.push({ repoArg: originUrl, headArg: headBranch });

  let lastError: string | null = null;
  let hadSuccessfulResponse = false;

  for (const { repoArg, headArg } of attempts) {
    const args = [
      "pr",
      "list",
      "--head",
      headArg,
      "--author",
      "@me",
      "--state",
      "all",
      "--json",
      "number,title,url,state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft",
    ];
    if (repoArg) {
      const parsed = parseGitHubRepo(repoArg);
      if (parsed) args.push("--repo", parsed);
      else args.push("--repo", repoArg);
    }

    const result = await runGh(args, { cwd: workspacePath });
    if (!result.success) {
      // Surface specific errors (installed/auth) immediately
      if (
        result.error === "gh_not_installed" ||
        result.error === "gh_not_authenticated" ||
        result.error === "timeout"
      ) {
        return { has_pr: false, error: result.error };
      }
      lastError = result.error; // Track for surfacing if all attempts fail
      continue;
    }

    let prs: any[];
    try {
      prs = JSON.parse(result.stdout || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(prs)) continue;
    hadSuccessfulResponse = true;

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

      // Closed PRs are terminal — no CI or merge status is relevant
      if (state === "closed") {
        return {
          has_pr: true,
          pr_number: pr.number,
          pr_title: pr.title,
          pr_url: pr.url,
          pr_state: "closed",
          merge_status: "blocked",
          is_draft: pr.isDraft === true,
          has_conflicts: false,
          ci_status: "unknown",
          review_status: "none",
          error: null,
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
        has_pr: true,
        pr_number: pr.number,
        pr_title: pr.title,
        pr_url: pr.url,
        pr_state: state,
        merge_status: mergeStatus,
        is_draft: pr.isDraft === true,
        has_conflicts: pr.mergeStateStatus === "DIRTY",
        ci_status: ciStatus,
        checks_done: checksDone,
        checks_total: checksTotal,
        checks: checkDetails,
        review_status: reviewStatus,
        error: null,
      };
    }
  }

  // If all attempts failed with errors, surface it instead of silently showing "no PR".
  // lastError is only set for 'unknown' errors (timeout/auth/install return immediately).
  return { has_pr: false, error: !hadSuccessfulResponse && lastError ? "network" : null };
}
