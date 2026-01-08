/**
 * File Changes Feature
 * File changes panel with tree view and single file diff display
 */

// Types
export type {
  FileChangeStatus,
  FileChangeTreeNode,
  HighlightedDiffLine,
  HighlightedHunk,
  FileDiffData,
  TreeState,
  WordDiffCacheEntry,
} from "./types";

// Constants
export { DIFF_VIEWER, FILE_TREE, ANIMATION } from "./constants";

// UI Components
export { FileChangesPanel, FileChangeTree, FileTreeNode, FileStatusIcon } from "./ui";

// Hooks
export { useTreeState } from "./hooks";

// Utilities
export { buildFileTree, getFilePaths, findNodeByPath, getAutoExpandPaths } from "./lib";
