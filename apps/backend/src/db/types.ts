/**
 * Database row types — internal to the backend.
 *
 * These match the raw shapes returned by better-sqlite3 queries.
 * They are NOT the API contract (see shared/types/ for that).
 * The `as` casts live in queries.ts, not in route handlers.
 */

// ─── repositories ────────────────────────────────────────────

export interface RepositoryRow {
  id: string;
  name: string;
  root_path: string;
  git_default_branch: string;
  sort_order: number;
  git_origin_url: string | null;
  updated_at: string;
}

/** GET /repos — repositories with workspace counts from LEFT JOIN aggregate. */
export interface RepositoryWithCountsRow extends RepositoryRow {
  ready_count: number;
  archived_count: number;
  total_count: number;
}

// ─── workspaces ──────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  repository_id: string;
  slug: string;
  title: string | null;
  git_branch: string | null;
  git_target_branch: string | null;
  state: string;
  status: string;
  current_session_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  archive_commit: string | null;
  archived_at: string | null;
  setup_status: string;
  init_stage: string | null;
  error_message: string | null;
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
  slug: string;
  title: string | null;
  git_branch: string | null;
  git_target_branch: string | null;
  state: string;
  status: string;
  current_session_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  init_stage: string | null;
  updated_at: string;

  // Setup tracking (deus.json manifest)
  setup_status: string;
  error_message: string | null;

  // From repositories JOIN
  repo_name: string | null;
  root_path: string | null;
  git_default_branch: string | null;
  /** Only in by-repo query */
  repo_sort_order?: number;
  /** Only in by-repo query — GitHub remote URL */
  git_origin_url?: string | null;

  // From sessions JOIN (null when no active session)
  session_status: string | null;
  current_session_title: string | null;
  session_error_category: string | null;
  session_error_message: string | null;
  latest_message_sent_at: string | null;
}

// ─── sessions ────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  workspace_id: string;
  agent_harness: string;
  agent_session_id: string | null;
  title: string | null;
  status: string;
  message_count: number;
  error_message: string | null;
  error_category: string | null;
  last_user_message_at: string | null;
  context_token_count: number;
  context_used_percent: number;
  is_hidden: boolean; // SQLite stores as INTEGER 0/1, coerced by coerceSessionBooleans
  updated_at: string;
}

/** Session joined with workspace info. */
export interface SessionWithDetailsRow extends SessionRow {
  slug: string | null;
  workspace_state: string | null;
}

// ─── messages ────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content: string | null;
  turn_id: string | null;
  model: string | null;
  agent_message_id: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  parent_tool_use_id: string | null;
  stop_reason: string | null;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  seq: number;
  type: string;
  data: string;
  tool_call_id: string | null;
  tool_name: string | null;
  parent_tool_call_id: string | null;
}

/** MessageRow enriched with parsed Part objects from the parts table. */
export interface MessageRowWithParts extends MessageRow {
  parts: import("@shared/messages/types").Part[];
}

// ─── stats ───────────────────────────────────────────────────

export interface StatsRow {
  workspaces: number;
  workspaces_ready: number;
  workspaces_archived: number;
  workspaces_backlog: number;
  workspaces_in_progress: number;
  workspaces_in_review: number;
  repositories: number;
  sessions: number;
  sessions_idle: number;
  sessions_working: number;
  messages: number;
}
