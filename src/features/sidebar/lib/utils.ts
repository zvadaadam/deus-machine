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
  // Use semantic tokens from design system for theme consistency
  const schemes = [
    { bg: "bg-primary/10", text: "text-primary" },
    { bg: "bg-secondary/10", text: "text-secondary-foreground" },
    { bg: "bg-accent/10", text: "text-accent-foreground" },
    { bg: "bg-muted", text: "text-muted-foreground" },
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
