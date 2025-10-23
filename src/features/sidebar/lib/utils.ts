/**
 * Sidebar utility functions
 * Extracted from AppSidebar.tsx for better organization
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
 * @returns Tailwind bg and text color classes
 */
export function getRepoColor(repoName: string): { bg: string; text: string } {
  const hash = repoName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const colors = [
    { bg: "bg-blue-500/10", text: "text-blue-700 dark:text-blue-400" },
    { bg: "bg-purple-500/10", text: "text-purple-700 dark:text-purple-400" },
    { bg: "bg-green-500/10", text: "text-green-700 dark:text-green-400" },
    { bg: "bg-orange-500/10", text: "text-orange-700 dark:text-orange-400" },
  ];
  return colors[hash % colors.length];
}
