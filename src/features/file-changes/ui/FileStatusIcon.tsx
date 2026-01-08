/**
 * File Status Icon
 * Visual indicator for file change status (added/modified/deleted)
 *
 * Design: Small colored dot overlaid on file icon
 * - Green: Added (new file)
 * - Yellow/Amber: Modified (changed file)
 * - Red: Deleted (removed file)
 */

import type { FileChangeStatus } from "../types";

interface FileStatusIconProps {
  status: FileChangeStatus;
  className?: string;
}

/**
 * Status indicator dot with appropriate color
 */
export function FileStatusIcon({ status, className = "" }: FileStatusIconProps) {
  const statusColors = {
    added: "bg-success", // Green
    modified: "bg-warning", // Amber/Yellow
    deleted: "bg-destructive", // Red
  };

  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${statusColors[status]} ${className}`}
      aria-label={`File ${status}`}
    />
  );
}
