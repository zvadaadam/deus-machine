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
  /** The lookup found a PR or ruled one out in every repository checked. */
  conclusive?: boolean;
  /** Set only when `git remote` lists no remotes for the local checkout. */
  no_remote?: true;
  pr_number?: number;
  pr_title?: string;
  pr_url?: string;
  base_branch?: string;
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
  error?: "gh_not_installed" | "gh_not_authenticated" | "timeout" | "unknown" | null;
}

/**
 * GitHub CLI availability + active account identity.
 * Combines `gh auth status` (installed/authenticated) with `gh api user`
 * (login, display name, avatar). Cached on the frontend with a long
 * staleTime since this rarely changes during a session.
 */
/** An organization's Deus GitHub App, as Deus Cloud reports it. */
export interface GithubAppState {
  /** Deus Cloud has the App registered (503 until then). */
  configured: boolean;
  signedIn: boolean;
  installations: Array<{ installationId: number; accountLogin: string }>;
  /** The App's slug, for install links; null until registered. */
  appSlug: string | null;
  /** `owner/name` the installations reach; null when the lookup failed (unknown is not "none"). */
  accessibleRepos: string[] | null;
  error?: string;
}

export interface GhCliStatus {
  isInstalled: boolean;
  isAuthenticated: boolean;
  /** GitHub login (e.g. "octocat"). Null when unauthenticated. */
  login?: string | null;
  /** Profile display name (e.g. "The Octocat"). May be null even when authenticated. */
  displayName?: string | null;
  /** Public avatar URL from githubusercontent.com. Null when unauthenticated or unreachable. */
  avatarUrl?: string | null;
  /** Profile URL (e.g. "https://github.com/octocat"). */
  htmlUrl?: string | null;
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
