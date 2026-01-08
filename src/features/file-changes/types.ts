/**
 * File Changes Feature Types
 * Types for the GitHub PR-style file changes panel
 */

import type { DiffHunk, DiffLine } from "@/shared/lib/syntaxHighlighter";
import type { HighlightRange } from "@/shared/lib/wordDiff";

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

/**
 * Enhanced diff line with syntax highlighting applied
 */
export interface HighlightedDiffLine extends DiffLine {
  /** HTML string with syntax highlighting */
  highlightedCode: string;
}

/**
 * Highlighted hunk with all lines processed
 */
export interface HighlightedHunk extends Omit<DiffHunk, "lines"> {
  lines: HighlightedDiffLine[];
}

/**
 * File diff data for the unified scroll view
 */
export interface FileDiffData {
  /** File path */
  filePath: string;
  /** Change status */
  status: FileChangeStatus;
  /** Lines added */
  additions: number;
  /** Lines deleted */
  deletions: number;
  /** Raw diff content */
  diff: string;
  /** Parsed and highlighted hunks */
  hunks?: HighlightedHunk[];
  /** Loading state */
  isLoading?: boolean;
  /** Error message */
  error?: string;
}

/**
 * Tree expand/collapse state
 * Persisted per workspace
 */
export interface TreeState {
  /** Set of expanded directory paths */
  expandedPaths: string[];
}

/**
 * Word diff cache entry type
 * Used to avoid recalculating word diffs for adjacent lines
 */
export interface WordDiffCacheEntry {
  oldRanges: HighlightRange[];
  newRanges: HighlightRange[];
}

/**
 * Structured error response for diff operations
 * Provides retryable flag and specific error reasons for UI handling
 */
export interface DiffError {
  error: "diff_failed" | "server_error" | "network_error" | "validation_error" | "not_found";
  message: string;
  retryable: boolean;
  details?: {
    file?: string;
    parentBranch?: string;
    reason?: "timeout" | "branch_not_found" | "not_git_repo" | "git_error";
    errorMessage?: string;
  };
}

/**
 * State for a single file's diff in the unified view
 */
export interface FileDiffState {
  diff: string;
  isLoading: boolean;
  error?: DiffError;
}
