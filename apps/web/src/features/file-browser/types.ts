/**
 * File Browser Types
 */

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  children?: FileTreeNode[];
  git_status?: "modified" | "added" | "deleted" | "untracked";
  /** Line additions from git diff (overlaid from file changes data) */
  additions?: number;
  /** Line deletions from git diff (overlaid from file changes data) */
  deletions?: number;
  /** Change status from git diff */
  change_status?: "added" | "modified" | "deleted";
  /** true = committed (in HEAD), false = uncommitted (working dir only) */
  committed?: boolean;
}

export interface FileTreeResponse {
  files: FileTreeNode[];
  totalFiles: number;
  totalSize: number;
}
