/**
 * Tauri Git Operations
 *
 * Typed wrappers for Rust git commands via Tauri IPC.
 * These bypass the Node.js backend entirely for faster git operations
 * using libgit2 in-process (~5-20ms vs 50-200ms via git CLI).
 */

import type { DiffStats, FileChange } from "@shared/types/workspace";
import { invoke } from "./invoke";

export interface TauriFileDiff {
  file: string;
  diff: string;
  old_content: string | null;
  new_content: string | null;
}

export interface TauriChangedFilesResult {
  files: FileChange[];
  truncated: boolean;
  total_count: number;
}

export function gitDiffStats(
  workspacePath: string,
  parentBranch: string,
  defaultBranch: string
): Promise<DiffStats> {
  return invoke<DiffStats>("git_diff_stats", {
    workspacePath,
    parentBranch,
    defaultBranch,
  });
}

export function gitDiffFiles(
  workspacePath: string,
  parentBranch: string,
  defaultBranch: string
): Promise<TauriChangedFilesResult> {
  return invoke<TauriChangedFilesResult>("git_diff_files", {
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

export function gitUncommittedFiles(workspacePath: string): Promise<FileChange[]> {
  return invoke<FileChange[]>("git_uncommitted_files", {
    workspacePath,
  });
}

export function gitLastTurnFiles(
  workspacePath: string,
  sessionId: string
): Promise<FileChange[]> {
  return invoke<FileChange[]>("git_last_turn_files", {
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
