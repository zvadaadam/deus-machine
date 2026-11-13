/** What a client reads about a workspace's files. */

/** One file or folder in a workspace's tree. */
export interface FileTreeNode {
  name: string;
  /** Relative to the workspace root. */
  path: string;
  type: "file" | "directory";
  /** Bytes; files only. */
  size?: number;
  children?: FileTreeNode[];
}

export interface FileTreeResponse {
  files: FileTreeNode[];
  totalFiles: number;
  totalSize: number;
  /** A cloud sandbox holds more files than it listed. */
  truncated?: boolean;
  /** A cloud workspace still being set up: nothing to list yet. */
  provisioning?: boolean;
}

/** One file a search found; a higher `score` is a better match. */
export interface FileMatch {
  path: string;
  name: string;
  score: number;
}
