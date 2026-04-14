/**
 * Workspace-related TypeScript type definitions
 * Centralized types for workspace entities and operations
 */

import type { SessionStatus } from "./session";

// Canonical enum types — defined as Zod schemas in shared/enums.ts,
// imported here for local use and re-exported for backwards compat.
import type { WorkspaceState, SetupStatus, WorkspaceStatus } from "../enums";
export type { WorkspaceState, SetupStatus, WorkspaceStatus };

/**
 * Core workspace entity
 * Represents a git worktree-based development workspace
 */
export interface Workspace {
  id: string;
  repository_id: string;
  slug: string;
  title: string | null;
  git_branch: string | null;
  git_target_branch: string | null;
  state: WorkspaceState;
  status: WorkspaceStatus;
  current_session_id: string | null;
  session_status: SessionStatus | null;
  model: string | null;
  session_error_category: string | null;
  session_error_message: string | null;
  latest_message_sent_at: string | null;
  updated_at: string;
  repo_name: string;
  root_path: string;
  /** Computed filesystem path to the workspace directory */
  workspace_path: string;
  git_default_branch?: string;
  setup_status: SetupStatus;
  init_stage?: string | null;
  error_message: string | null;
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
  sort_order: number;
  git_origin_url?: string | null;
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
  /** true = committed (in HEAD), false = uncommitted (working dir only), undefined = unknown */
  committed?: boolean;
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

/**
 * Full file diff content from git
 * Includes raw diff text and old/new file contents for side-by-side view
 */
export interface FileDiff {
  file: string;
  diff: string;
  old_content: string | null;
  new_content: string | null;
}
