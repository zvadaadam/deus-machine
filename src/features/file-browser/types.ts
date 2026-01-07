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
}

export interface FileTreeResponse {
  files: FileTreeNode[];
  totalFiles: number;
  totalSize: number;
}
