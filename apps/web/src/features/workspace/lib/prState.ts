import type { UseQueryResult } from "@tanstack/react-query";
import type { PRStatus, GhCliStatus, CheckDetail, Workspace } from "@/shared/types";

/**
 * Wait for the first lookup. A known PR shows merged, closed, conflicts, failing checks, requested
 * changes, pending checks, then ready or awaiting review. An incomplete snapshot shows the PR link.
 * Without a PR, check CLI availability, then the remote, then offer Create PR with any lookup warning.
 */
export type PRActionState =
  | { type: "checking" }
  | { type: "gh_unavailable"; warning: string }
  | { type: "linked"; prNumber: number; prUrl: string; warning: string }
  | { type: "no_remote" }
  | { type: "create_pr"; warning?: string }
  | { type: "merged"; prNumber: number; prUrl: string }
  | { type: "closed"; prNumber: number; prUrl: string }
  | { type: "conflicts"; prNumber: number; prUrl: string }
  | {
      type: "ci_failing";
      prNumber: number;
      prUrl: string;
      checksDone: number;
      checksTotal: number;
      failingChecks: CheckDetail[];
    }
  | { type: "changes_requested"; prNumber: number; prUrl: string }
  | { type: "ci_pending"; prNumber: number; prUrl: string; checksDone: number; checksTotal: number }
  | { type: "ready_to_merge"; prNumber: number; prUrl: string; baseBranch: string }
  | { type: "awaiting_review"; prNumber: number; prUrl: string };

const LOOKUP_WARNINGS: Record<NonNullable<PRStatus["error"]>, string> = {
  gh_not_installed: "GitHub integration is unavailable on this computer. Check Settings.",
  gh_not_authenticated: "Connect GitHub in Settings to check for a pull request.",
  timeout: "GitHub took too long to check for a pull request.",
  unknown: "Could not check for a pull request on GitHub.",
};

export function mergeLabel(baseBranch: string): string {
  return `Merge into ${baseBranch}`;
}

export function derivePRActionState(
  lookup: Pick<
    UseQueryResult<PRStatus | null>,
    "data" | "isLoading" | "isFetched" | "isEnabled" | "isError"
  >,
  ghStatus: GhCliStatus | null | undefined,
  workspace?: Workspace | null
): PRActionState {
  if (lookup.isEnabled && lookup.isLoading && !lookup.isFetched) return { type: "checking" };
  let failure = lookup.isError ? "unknown" : lookup.data?.error;
  if (ghStatus?.isInstalled === false) failure = "gh_not_installed";
  else if (ghStatus?.isAuthenticated === false) failure = "gh_not_authenticated";

  // The row keeps the last known lifecycle, or the link a PR workspace started with.
  let prStatus = failure ? undefined : lookup.data;
  if (
    failure &&
    workspace?.pr_number &&
    workspace.pr_url &&
    (workspace.pr_state || !workspace.pr_checked_at)
  ) {
    prStatus = {
      has_pr: true,
      pr_number: workspace.pr_number,
      pr_url: workspace.pr_url,
      pr_state: workspace.pr_state ?? undefined,
      has_conflicts: !!workspace.pr_has_conflicts,
      ci_status: workspace.pr_ci_status ?? undefined,
      review_status: workspace.pr_review_status ?? undefined,
    };
  }

  if (!prStatus?.has_pr || !prStatus.pr_number) {
    if (failure === "gh_not_installed" || failure === "gh_not_authenticated") {
      return { type: "gh_unavailable", warning: LOOKUP_WARNINGS[failure] };
    }
    if (prStatus?.no_remote) return { type: "no_remote" };
    if (failure) return { type: "create_pr", warning: LOOKUP_WARNINGS[failure] };
    return { type: "create_pr" };
  }

  const prNumber = prStatus.pr_number;
  const prUrl = prStatus.pr_url ?? "";

  if (prStatus.pr_state === "merged" || prStatus.merge_status === "merged") {
    return { type: "merged", prNumber, prUrl };
  }

  if (prStatus.pr_state === "closed") {
    return { type: "closed", prNumber, prUrl };
  }

  if (prStatus.has_conflicts) {
    return { type: "conflicts", prNumber, prUrl };
  }
  const checksDone = prStatus.checks_done ?? 0;
  const checksTotal = prStatus.checks_total ?? 0;
  if (prStatus.ci_status === "failing") {
    const failingChecks = (prStatus.checks ?? []).filter((c) => c.status === "failing");
    return { type: "ci_failing", prNumber, prUrl, checksDone, checksTotal, failingChecks };
  }
  if (prStatus.review_status === "changes_requested") {
    return { type: "changes_requested", prNumber, prUrl };
  }
  if (prStatus.ci_status === "pending") {
    return { type: "ci_pending", prNumber, prUrl, checksDone, checksTotal };
  }
  // GitHub can still be recalculating mergeability after the checks have passed.
  const ready = prStatus.merge_status === "ready" || prStatus.ci_status === "passing";
  if (ready && prStatus.base_branch) {
    return { type: "ready_to_merge", prNumber, prUrl, baseBranch: prStatus.base_branch };
  }
  // The row has no mergeability or base. It can still say that a review is required.
  if (failure && (ready || prStatus.review_status !== "review_required")) {
    return { type: "linked", prNumber, prUrl, warning: LOOKUP_WARNINGS[failure] };
  }
  return { type: "awaiting_review", prNumber, prUrl };
}

/** The starting target for Create PR and the sidebar's workspace hover card. */
export function prTargetBranch(
  workspace: Pick<Workspace, "git_target_branch" | "git_default_branch"> | null | undefined
): string {
  return workspace?.git_target_branch || workspace?.git_default_branch || "main";
}
