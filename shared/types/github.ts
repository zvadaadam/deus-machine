/**
 * GitHub-related TypeScript type definitions
 * Types for GitHub PR and repository operations
 */

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
  review_status?: "approved" | "changes_requested" | "review_required" | "none";
  error?: "gh_not_installed" | "gh_not_authenticated" | "timeout" | null;
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
 * Development server information
 * Local dev servers detected in workspace
 */
export interface DevServer {
  port: number;
  url: string;
  type: "vite" | "webpack" | "angular" | "node" | "other";
  name: string;
}
