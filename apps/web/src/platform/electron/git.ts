/**
 * Electron Git Operations (Stubs)
 *
 * In the Electron architecture, git operations are handled by the Node.js
 * backend via HTTP. These stubs throw so that the try/catch fallback pattern
 * in workspace.service.ts kicks in and routes through the HTTP endpoints.
 *
 * These stub functions throw immediately so the try/catch fallback in
 * workspace.service.ts routes through HTTP instead.
 */

import type { BranchInfo, ChangedFilesResult, DiffStats, FileChange, FileDiff } from "@shared/types/workspace";

export type { BranchInfo, ChangedFilesResult, FileDiff };

export function gitDiffStats(
  _workspacePath: string,
  _parentBranch: string,
  _defaultBranch: string
): Promise<DiffStats> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}

export function gitDiffFiles(
  _workspacePath: string,
  _parentBranch: string,
  _defaultBranch: string
): Promise<ChangedFilesResult> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}

export function gitDiffFile(
  _workspacePath: string,
  _parentBranch: string,
  _defaultBranch: string,
  _filePath: string
): Promise<FileDiff> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}

export function gitUncommittedFiles(_workspacePath: string): Promise<FileChange[]> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}

export function gitLastTurnFiles(
  _workspacePath: string,
  _sessionId: string
): Promise<FileChange[]> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}

export function gitDetectDefaultBranch(_rootPath: string): Promise<string> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}

export function gitListBranches(_workspacePath: string): Promise<BranchInfo[]> {
  throw new Error("Git IPC not available in Electron — use HTTP fallback");
}
