/**
 * PR View State -- derives a single discriminated union from raw PR + GH CLI status.
 *
 * This is the ONLY place that interprets PRStatus into what the UI should show.
 * The priority ordering is explicit: earlier checks shadow later ones.
 *
 * Pure function. No React. Trivially testable.
 */

import type { PRStatus, GhCliStatus } from "@/shared/types";

/**
 * Discriminated union of all possible PR action states.
 * Each variant carries only the data its rendering path needs.
 *
 * Priority order (highest to lowest):
 *   1. gh CLI unavailable (blocks everything)
 *   2. error (GitHub unreachable — timeout or network failure)
 *   3. no PR (initial state)
 *   4. merged (terminal)
 *   5. closed (terminal — not merged)
 *   6. conflicts (must resolve before anything else)
 *   7. CI failing (fixable, blocks merge)
 *   8. changes requested (reviewer feedback pending)
 *   9. CI pending (waiting, no action)
 *  10. ready to merge (all green)
 *  11. awaiting review (CI passed, needs review)
 */
export type PRActionState =
  | { type: "gh_unavailable"; reason: "not_installed" | "not_authenticated" }
  | { type: "error"; reason: "timeout" | "network" }
  | { type: "no_pr" }
  | { type: "merged"; prNumber: number; prUrl: string }
  | { type: "closed"; prNumber: number; prUrl: string }
  | { type: "conflicts"; prNumber: number; prUrl: string }
  | { type: "ci_failing"; prNumber: number; prUrl: string }
  | { type: "changes_requested"; prNumber: number; prUrl: string }
  | { type: "ci_pending"; prNumber: number; prUrl: string }
  | { type: "ready_to_merge"; prNumber: number; prUrl: string; targetBranch: string }
  | { type: "awaiting_review"; prNumber: number; prUrl: string };

/**
 * Collapses PRStatus + GhCliStatus into a single discriminated state.
 * The priority ordering ensures that when multiple flags are true
 * (e.g., conflicts + CI failing), only the highest-priority state wins.
 */
export function derivePRActionState(
  prStatus: PRStatus | null,
  ghStatus: GhCliStatus | null | undefined,
  targetBranch: string,
): PRActionState {
  // gh CLI gates everything
  if (ghStatus && !ghStatus.isInstalled) {
    return { type: "gh_unavailable", reason: "not_installed" };
  }
  if (ghStatus && ghStatus.isInstalled && !ghStatus.isAuthenticated) {
    return { type: "gh_unavailable", reason: "not_authenticated" };
  }

  // gh CLI errors from the PR status endpoint — can arrive during the ghStatus
  // 5-minute stale window (e.g., gh is uninstalled between status checks).
  if (prStatus?.error === "gh_not_installed") {
    return { type: "gh_unavailable", reason: "not_installed" };
  }
  if (prStatus?.error === "gh_not_authenticated") {
    return { type: "gh_unavailable", reason: "not_authenticated" };
  }

  // GitHub unreachable — surface error before interpreting has_pr,
  // since has_pr: false might just mean the request failed.
  if (prStatus?.error === "timeout") {
    return { type: "error", reason: "timeout" };
  }
  if (prStatus?.error === "network") {
    return { type: "error", reason: "network" };
  }

  // No PR exists yet
  if (!prStatus?.has_pr || !prStatus.pr_number) {
    return { type: "no_pr" };
  }

  const prNumber = prStatus.pr_number;
  const prUrl = prStatus.pr_url ?? "";

  // Merged is terminal
  if (prStatus.merge_status === "merged") {
    return { type: "merged", prNumber, prUrl };
  }

  // Closed (not merged) is terminal — no actionable state
  if (prStatus.pr_state === "closed") {
    return { type: "closed", prNumber, prUrl };
  }

  // Priority-ordered actionable states for open PRs
  if (prStatus.has_conflicts) {
    return { type: "conflicts", prNumber, prUrl };
  }
  if (prStatus.ci_status === "failing") {
    return { type: "ci_failing", prNumber, prUrl };
  }
  if (prStatus.review_status === "changes_requested") {
    return { type: "changes_requested", prNumber, prUrl };
  }
  if (prStatus.ci_status === "pending") {
    return { type: "ci_pending", prNumber, prUrl };
  }
  if (prStatus.merge_status === "ready") {
    return { type: "ready_to_merge", prNumber, prUrl, targetBranch };
  }

  // Fallback: CI passing + review needed, or any other open PR state
  // (draft, unknown CI, etc.) — safest default, no destructive action
  return { type: "awaiting_review", prNumber, prUrl };
}
