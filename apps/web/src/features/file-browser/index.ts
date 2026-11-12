/**
 * File Browser Feature
 * Browse and view files in the workspace working tree
 *
 * The backend scans the tree (.gitignore-aware) and reads the files.
 */

// Types
export type { FileTreeNode, FileTreeResponse } from "./types";

// API Hooks
export { useFiles, useFileContent } from "./api";

// UI Components
export { FileBrowserPanel, FileViewer, FileTree } from "./ui";
