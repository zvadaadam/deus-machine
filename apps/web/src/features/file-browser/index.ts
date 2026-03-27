/**
 * File Browser Feature
 * Browse and view files in the workspace working tree
 *
 * Uses backend HTTP endpoints for .gitignore-aware file scanning.
 */

// Types
export type { FileTreeNode, FileTreeResponse } from "./types";

// API Hooks
export { useFiles, invalidateFileCache, useFileContent } from "./api";

// UI Components
export { FileBrowserPanel, FileViewer, FileTree } from "./ui";
