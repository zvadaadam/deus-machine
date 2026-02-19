/**
 * Database row types — internal to the backend.
 *
 * These match the raw shapes returned by better-sqlite3 queries.
 * They are NOT the API contract (see shared/types/ for that).
 * The `as` casts live in queries.ts, not in route handlers.
 */

// ─── repos ───────────────────────────────────────────────────

export interface RepoRow {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  display_order: number;
  github_url: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /repos — repos with workspace counts from LEFT JOIN aggregate. */
export interface RepoWithCountsRow extends RepoRow {
  ready_count: number;
  archived_count: number;
  total_count: number;
}

// ─── workspaces ──────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  repository_id: string;
  directory_name: string;
  display_name: string | null;
  branch: string | null;
  parent_branch: string | null;
  state: string;
  active_session_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  archive_commit: string | null;
  archived_at: string | null;
  setup_status: string;
  setup_error: string | null;
  init_step: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Workspace joined with repo + active session.
 * Used by GET /workspaces, GET /workspaces/:id, GET /workspaces/by-repo,
 * and the withWorkspace middleware.
 */
export interface WorkspaceWithDetailsRow {
  // From workspaces table
  id: string;
  repository_id: string;
  directory_name: string;
  display_name: string | null;
  branch: string | null;
  parent_branch: string | null;
  state: string;
  active_session_id: string | null;
  init_step: string | null;
  created_at: string;
  updated_at: string;

  // Setup tracking (hive.json manifest)
  setup_status: string;
  setup_error: string | null;

  // From repos JOIN
  repo_name: string | null;
  root_path: string | null;
  default_branch: string | null;
  /** Only in by-repo query */
  repo_display_order?: number;

  // From sessions JOIN (null when no active session)
  session_status: string | null;
  model: string | null;
  latest_message_sent_at: string | null;
}

// ─── sessions ────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  workspace_id: string;
  agent_type: string;
  title: string | null;
  status: string;
  model: string;
  sdk_session_id: string | null;
  message_count: number;
  error_message: string | null;
  last_user_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Session joined with workspace info. */
export interface SessionWithDetailsRow extends SessionRow {
  directory_name: string | null;
  workspace_state: string | null;
}

// ─── session_messages ────────────────────────────────────────

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content: string | null;
  turn_id: string | null;
  model: string | null;
  sdk_message_id: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

// ─── stats ───────────────────────────────────────────────────

export interface StatsRow {
  workspaces: number;
  workspaces_ready: number;
  workspaces_archived: number;
  repos: number;
  sessions: number;
  sessions_idle: number;
  sessions_working: number;
  messages: number;
}

// ─── settings ────────────────────────────────────────────────

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}
