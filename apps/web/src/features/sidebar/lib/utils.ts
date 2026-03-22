/**
 * Sidebar utility functions
 * Extracted from AppSidebar.tsx for better organization
 *
 * For status-related utilities (colors, priorities, sorting),
 * @see status.ts
 */

/**
 * Get repository initials for display
 * @param repoName - Repository name (e.g., "box-ide" or "owner/repo")
 * @returns Uppercase initials (e.g., "BI" or "OR")
 */
export function getRepoInitials(repoName: string): string {
  const parts = repoName.split(/[-_\s]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return repoName.slice(0, 2).toUpperCase();
}

/**
 * Get color scheme for repository badge based on name hash
 * @param repoName - Repository name
 * @returns Semantic design token classes
 */
export function getRepoColor(repoName: string): { bg: string; text: string } {
  const hash = repoName.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  // Use semantic tokens so colors follow the design system theme.
  const schemes = [
    { bg: "bg-primary/20", text: "text-primary" },
    { bg: "bg-secondary/30", text: "text-secondary-foreground" },
    { bg: "bg-accent/30", text: "text-accent-foreground" },
    { bg: "bg-muted", text: "text-muted-foreground" },
    { bg: "bg-sidebar-accent", text: "text-sidebar-foreground" },
  ];
  return schemes[hash % schemes.length];
}

/**
 * Clean repository display name by removing username prefix
 * @param repoName - Full repository name (e.g., "zvadaadam/overlay" or "box-ide")
 * @returns Clean display name (e.g., "overlay" or "box-ide")
 */
export function getCleanRepoName(repoName: string): string {
  // Check if repo name contains username prefix (format: "username/repo")
  const parts = repoName.split("/");
  if (parts.length === 2) {
    // Return just the repo name without username
    return parts[1];
  }
  // Return as-is if no prefix
  return repoName;
}

/**
 * Smart display name for workspace sidebar row.
 *
 * Priority:
 *   1. workspace.title — AI-generated summary (after first turn), PR title, or user rename
 *   2. workspace.slug  — celestial name (clean, human-readable)
 *   3. workspace.git_branch — raw branch name as absolute fallback
 *   4. "New workspace" — nothing available yet (during early init)
 */
export function getWorkspaceDisplayName(workspace: {
  title: string | null;
  slug: string;
  git_branch: string | null;
}): string {
  if (workspace.title) return workspace.title;
  if (workspace.slug) return workspace.slug;
  return workspace.git_branch || "New workspace";
}

/**
 * Secondary line text for the workspace sidebar row.
 *
 * When a title is displayed (AI-generated, PR title, or user rename),
 * show the slug as context. When slug IS the primary name, return null.
 */
export function getWorkspaceSecondaryText(workspace: {
  title: string | null;
  slug: string;
}): string | null {
  // Show slug as secondary only when title is the primary display name
  if (workspace.title && workspace.slug) return workspace.slug;
  return null;
}
