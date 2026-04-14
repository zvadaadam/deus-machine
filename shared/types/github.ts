/**
 * GitHub-related TypeScript type definitions
 * Types for GitHub PR and repository operations
 */

/** Individual CI check result from GitHub's statusCheckRollup */
export interface CheckDetail {
  name: string;
  status: "passing" | "failing" | "pending";
  url?: string;
}

/**
 * Pull Request status information
 * Metadata about a PR associated with a workspace
 */
export interface PRStatus {
  has_pr: boolean;
  pr_number?: number;
  pr_title?: string;
  pr_url?: string;
  pr_state?: "open" | "merged" | "closed";
  merge_status?: "ready" | "blocked" | "merged";
  is_draft?: boolean;
  has_conflicts?: boolean;
  ci_status?: "passing" | "failing" | "pending" | "unknown";
  /** Number of checks that have completed (passing + failing, excludes pending) */
  checks_done?: number;
  /** Total number of checks in the rollup */
  checks_total?: number;
  /** Per-check breakdown from statusCheckRollup */
  checks?: CheckDetail[];
  review_status?: "approved" | "changes_requested" | "review_required" | "none";
  error?: "gh_not_installed" | "gh_not_authenticated" | "timeout" | "network" | null;
}

/**
 * GitHub CLI availability status
 * Cached separately with long staleTime since it rarely changes
 */
export interface GhCliStatus {
  isInstalled: boolean;
  isAuthenticated: boolean;
}

/**
 * Summary of an open GitHub Pull Request
 * Used by the "Create Workspace from PR" picker
 */
export interface PRSummary {
  number: number;
  title: string;
  branch: string; // headRefName
  baseBranch: string; // baseRefName
  url: string;
  isDraft: boolean;
}

/**
 * Summary of a git branch (remote and/or local).
 * Used by the welcome screen and "Create Workspace from Branch" picker.
 */
export interface BranchSummary {
  name: string;
  is_remote?: boolean;
  is_local?: boolean;
}
