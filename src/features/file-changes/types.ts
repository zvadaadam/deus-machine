/**
 * File Changes Feature Types
 * Types for the GitHub PR-style file changes panel
 */

/**
 * File change status for visual indicators
 * - added: New file (green dot)
 * - modified: Changed file (yellow dot)
 * - deleted: Removed file (red dot)
 */
export type FileChangeStatus = "added" | "modified" | "deleted";

/**
 * Tree node for file changes (hierarchical structure)
 * Used to display files in a collapsible folder tree
 */
export interface FileChangeTreeNode {
  /** Filename or folder name */
  name: string;
  /** Full path from repository root */
  path: string;
  /** Node type */
  type: "file" | "directory";
  /** File status (only for files) */
  status?: FileChangeStatus;
  /** Lines added (only for files) */
  additions?: number;
  /** Lines deleted (only for files) */
  deletions?: number;
  /** Child nodes (only for directories) */
  children?: FileChangeTreeNode[];
}
