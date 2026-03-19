/**
 * File Browser Feature
 * Browse and view files in the workspace working tree
 *
 * Uses native file access via IPC - shows actual
 * disk content including uncommitted changes.
 */

// Types
export type { FileTreeNode, FileTreeResponse } from "./types";

// API Hooks
export { useFilesRust, invalidateFileCache, clearFileCache, useFileContent } from "./api";

// UI Components
export { FileBrowserPanel, FileViewer, FileTree } from "./ui";
