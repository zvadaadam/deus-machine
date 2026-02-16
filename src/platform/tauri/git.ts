/**
 * Tauri Git Operations
 *
 * Typed wrappers for Rust git commands via Tauri IPC.
 * These bypass the Node.js backend entirely for faster git operations
 * using libgit2 in-process (~5-20ms vs 50-200ms via git CLI).
 */

import { invoke } from "./invoke";

export interface TauriDiffStats {
  additions: number;
  deletions: number;
}

export interface TauriDiffFile {
  file: string;
  additions: number;
  deletions: number;
}

export interface TauriFileDiff {
  file: string;
  diff: string;
  old_content: string | null;
  new_content: string | null;
}

export function gitDiffStats(
  workspacePath: string,
  parentBranch: string,
  defaultBranch: string
): Promise<TauriDiffStats> {
  return invoke<TauriDiffStats>("git_diff_stats", {
    workspacePath,
    parentBranch,
    defaultBranch,
  });
}

export function gitDiffFiles(
  workspacePath: string,
  parentBranch: string,
  defaultBranch: string
): Promise<TauriDiffFile[]> {
  return invoke<TauriDiffFile[]>("git_diff_files", {
    workspacePath,
    parentBranch,
    defaultBranch,
  });
}

export function gitDiffFile(
  workspacePath: string,
  parentBranch: string,
  defaultBranch: string,
  filePath: string
): Promise<TauriFileDiff> {
  return invoke<TauriFileDiff>("git_diff_file", {
    workspacePath,
    parentBranch,
    defaultBranch,
    filePath,
  });
}

export function gitUncommittedFiles(workspacePath: string): Promise<TauriDiffFile[]> {
  return invoke<TauriDiffFile[]>("git_uncommitted_files", {
    workspacePath,
  });
}

export function gitLastTurnFiles(
  workspacePath: string,
  sessionId: string
): Promise<TauriDiffFile[]> {
  return invoke<TauriDiffFile[]>("git_last_turn_files", {
    workspacePath,
    sessionId,
  });
}

export function gitDetectDefaultBranch(rootPath: string): Promise<string> {
  return invoke<string>("git_detect_default_branch", {
    rootPath,
  });
}

export interface TauriBranchInfo {
  name: string;
  is_remote: boolean;
  is_head: boolean;
}

export function gitListBranches(workspacePath: string): Promise<TauriBranchInfo[]> {
  return invoke<TauriBranchInfo[]>("git_list_branches", {
    workspacePath,
  });
}
