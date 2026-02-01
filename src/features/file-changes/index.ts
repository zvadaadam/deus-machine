/**
 * File Changes Feature
 * File changes panel with tree view and single file diff display
 */

// Types
export type { FileChangeStatus, FileChangeTreeNode } from "./types";

// Constants
export { FILE_TREE } from "./constants";

// UI Components
export { FileChangesPanel, FileChangeTree, FileTreeNode } from "./ui";

// Hooks
export { useTreeState } from "./hooks";

// Utilities
export { buildFileTree, getAutoExpandPaths } from "./lib";
