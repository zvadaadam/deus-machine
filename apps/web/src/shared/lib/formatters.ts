/**
 * Utility functions for formatting data
 * Pure functions for display formatting
 */

/**
 * Format timestamp as relative time (e.g., "2h ago", "5d ago")
 * @param dateString - ISO date string from database
 * @returns Human-readable relative time string
 */
export function formatTimeAgo(dateString: string): string {
  const now = new Date();
  // SQLite stores dates as UTC strings without 'Z', so append 'Z' to parse as UTC
  const date = new Date(dateString.includes("Z") ? dateString : dateString + "Z");
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 0) return "just now"; // Handle future dates due to timezone issues
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 2592000)}mo ago`;
}
