/**
 * Workspace-related TypeScript type definitions
 * Centralized types for workspace entities and operations
 */

import type { SessionStatus } from "./session";

export type WorkspaceState = "ready" | "initializing" | "archived" | "error";

/**
 * Core workspace entity
 * Represents a git worktree-based development workspace
 */
export interface Workspace {
  id: string;
  repository_id: string;
  directory_name: string;
  display_name: string | null;
  branch: string | null;
  parent_branch: string | null;
  state: WorkspaceState;
  active_session_id: string | null;
  session_status: SessionStatus | null;
  model: string | null;
  latest_message_sent_at: string | null;
  created_at: string;
  updated_at: string;
  repo_name: string;
  root_path: string;
  /** Computed filesystem path to the workspace directory */
  workspace_path: string;
  default_branch?: string;
  pr_url?: string | null;
  pr_number?: number | null;
  archive_commit?: string | null;
  archived_at?: string | null;
}

/**
 * Repository grouping for sidebar display
 * Groups workspaces by their parent repository
 */
export interface RepoGroup {
  repo_id: string;
  repo_name: string;
  display_order: number;
  workspaces: Workspace[];
}

/**
 * Git diff statistics for a workspace
 * Shows additions and deletions relative to main branch
 */
export interface DiffStats {
  additions: number;
  deletions: number;
}

/**
 * File-level change information
 * Individual file modifications with line counts
 */
export interface FileChange {
  file: string;
  file_path?: string; // Some APIs use file_path instead
  additions: number;
  deletions: number;
}

/**
 * File edit details from Claude Code actions
 * Tracks Edit and Write tool usage per file
 */
export interface FileEdit {
  old_string?: string;
  new_string?: string;
  content?: string;
  timestamp: string;
  message_id: string;
  tool_name: "Edit" | "Write";
}

/**
 * Grouped file changes with edit history
 * Aggregates all edits for a specific file
 */
export interface FileChangeGroup {
  file_path: string;
  edits: FileEdit[];
  first_timestamp: string;
  last_timestamp: string;
}
