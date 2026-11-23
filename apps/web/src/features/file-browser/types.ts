/**
 * File Browser Types
 */

import type { FileTreeNode as ScannedNode } from "@shared/types/files";
import type { FileChangeStatus } from "@shared/types/workspace";

export type { FileTreeResponse } from "@shared/types/files";

/** A file or folder from the workspace's tree, with what the diff says about it laid over. */
export interface FileTreeNode extends ScannedNode {
  children?: FileTreeNode[];
  /** Line additions from git diff (overlaid from file changes data) */
  additions?: number;
  /** Line deletions from git diff (overlaid from file changes data) */
  deletions?: number;
  /** Change status from git diff */
  change_status?: FileChangeStatus;
  previous_path?: string;
  /** true = committed (in HEAD), false = uncommitted (working dir only) */
  committed?: boolean;
}
