/**
 * Workspace-related TypeScript type definitions
 * Centralized types for workspace entities and operations
 */

import type { SessionStatus } from "./session";

// Canonical enum types — defined as Zod schemas in shared/enums.ts,
// imported here for local use; the ones workspace importers read are re-exported.
import type {
  InitFetchIssue,
  WorkspaceKind,
  WorkspaceState,
  SetupStatus,
  WorkspaceStatus,
} from "../enums";
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
  /** Where the files live: local git worktree or an agnt cloud sandbox. */
  kind: WorkspaceKind;
  /** agnt workspace id backing a cloud workspace (null for local). */
  provider_workspace_id: string | null;
  /** The cloud organization a cloud workspace runs in (null for local, or not yet known). */
  organization_id: string | null;
  state: WorkspaceState;
  status: WorkspaceStatus;
  current_session_id: string | null;
  session_status: SessionStatus | null;
  session_error_category: string | null;
  session_error_message: string | null;
  latest_message_sent_at: string | null;
  /** The first chat's id, minted with the workspace, and that chat's own status and when it was last spoken to. */
  first_session_id?: string | null;
  first_session_status?: SessionStatus | null;
  first_session_last_message_at?: string | null;
  updated_at: string;
  repo_name: string;
  root_path: string;
  /** Computed filesystem path to the workspace directory */
  workspace_path: string;
  git_default_branch?: string;
  setup_status: SetupStatus;
  init_stage?: string | null;
  /** The plain reason starting (state `error`) or setup (`setup_status` failed) did not work. */
  error_message: string | null;
  /** What the tool printed when starting failed, or the log tail when the setup script failed. */
  error_detail?: string | null;
  /** Set when the workspace started without origin's latest. */
  init_fetch_issue?: InitFetchIssue | null;
  pr_url?: string | null;
  pr_number?: number | null;
  /** PR lifecycle snapshot — persisted by the backend from gh, pushed over WS. */
  pr_state?: "open" | "merged" | "closed" | null;
  pr_is_draft?: number | null;
  pr_review_status?: "approved" | "changes_requested" | "review_required" | "none" | null;
  pr_has_conflicts?: number | null;
  pr_ci_status?: "passing" | "failing" | "pending" | "unknown" | null;
  pr_checked_at?: string | null;
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
  /**
   * Whether the project has a folder on this computer. False for a project
   * added from GitHub, which runs only in the cloud. Absent where no backend
   * says (the hosted web's groups).
   */
  has_folder?: boolean;
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
