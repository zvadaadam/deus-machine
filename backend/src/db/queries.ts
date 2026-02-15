/**
 * Typed query functions — centralized DB reads for all route handlers.
 *
 * Every `as` cast lives here (once per query), not in routes.
 * Route handlers call these functions instead of inline SQL.
 */
import type Database from 'better-sqlite3';
import type {
  RepoRow,
  RepoWithCountsRow,
  WorkspaceRow,
  WorkspaceWithDetailsRow,
  SessionRow,
  SessionWithDetailsRow,
  MessageRow,
  StatsRow,
  SettingRow,
} from './types';

// ─── Workspace Queries ───────────────────────────────────────

/**
 * Canonical workspace + repo + session JOIN.
 * Single source of truth — reused by list, get-by-id, and by-repo queries.
 */
const WORKSPACE_DETAILS_SELECT = `
  SELECT
    w.id, w.repository_id, w.directory_name, w.display_name, w.branch,
    w.parent_branch, w.state, w.active_session_id, w.created_at, w.updated_at,
    r.name as repo_name, r.root_path, r.default_branch,
    s.status as session_status, s.model,
    s.last_user_message_at as latest_message_sent_at
  FROM workspaces w
  LEFT JOIN repos r ON w.repository_id = r.id
  LEFT JOIN sessions s ON w.active_session_id = s.id
`;

export function getAllWorkspaces(db: Database.Database): WorkspaceWithDetailsRow[] {
  return db.prepare(`
    ${WORKSPACE_DETAILS_SELECT}
    ORDER BY w.updated_at DESC
    LIMIT 100
  `).all() as WorkspaceWithDetailsRow[];
}

export function getWorkspacesByRepo(
  db: Database.Database,
  state?: string
): WorkspaceWithDetailsRow[] {
  const stateFilter = state ? 'WHERE w.state = ?' : '';
  return db.prepare(`
    SELECT
      w.id, w.repository_id, w.directory_name, w.display_name, w.branch,
      w.parent_branch, w.state, w.active_session_id, w.created_at, w.updated_at,
      r.name as repo_name, r.display_order as repo_display_order, r.root_path,
      r.default_branch,
      s.status as session_status, s.model,
      s.last_user_message_at as latest_message_sent_at
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    LEFT JOIN sessions s ON w.active_session_id = s.id
    ${stateFilter}
    ORDER BY r.display_order, r.name, w.updated_at DESC
  `).all(...(state ? [state] : [])) as WorkspaceWithDetailsRow[];
}

export function getWorkspaceById(
  db: Database.Database,
  id: string
): WorkspaceWithDetailsRow | undefined {
  return db.prepare(`
    ${WORKSPACE_DETAILS_SELECT}
    WHERE w.id = ?
  `).get(id) as WorkspaceWithDetailsRow | undefined;
}

/** Used by withWorkspace middleware — lighter query without session JOIN. */
export function getWorkspaceForMiddleware(
  db: Database.Database,
  id: string
): WorkspaceWithDetailsRow | undefined {
  return db.prepare(`
    SELECT w.*, r.root_path, r.default_branch, r.name as repo_name
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE w.id = ?
  `).get(id) as WorkspaceWithDetailsRow | undefined;
}

export function getWorkspaceRaw(
  db: Database.Database,
  id: string
): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
}

/** Workspace + repo only (no session JOIN). Used after workspace creation. */
export function getWorkspaceWithRepo(
  db: Database.Database,
  id: string
): WorkspaceWithDetailsRow | undefined {
  return db.prepare(`
    SELECT w.*, r.name as repo_name, r.root_path
    FROM workspaces w
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE w.id = ?
  `).get(id) as WorkspaceWithDetailsRow | undefined;
}

// ─── Session Queries ─────────────────────────────────────────

/**
 * Session query — uses denormalized message_count column
 * instead of COUNT(m.id) JOIN, eliminating expensive aggregation.
 */
const SESSION_DETAILS_SELECT = `
  SELECT s.*, w.directory_name, w.state as workspace_state
  FROM sessions s
  LEFT JOIN workspaces w ON s.id = w.active_session_id
`;

export function getAllSessions(db: Database.Database): SessionWithDetailsRow[] {
  return db.prepare(`
    ${SESSION_DETAILS_SELECT}
    ORDER BY s.updated_at DESC
    LIMIT 50
  `).all() as SessionWithDetailsRow[];
}

export function getSessionById(
  db: Database.Database,
  id: string
): SessionWithDetailsRow | undefined {
  return db.prepare(`
    ${SESSION_DETAILS_SELECT}
    WHERE s.id = ?
  `).get(id) as SessionWithDetailsRow | undefined;
}

export function getSessionRaw(
  db: Database.Database,
  id: string
): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

// ─── Message Queries ─────────────────────────────────────────

/**
 * Fetch paginated messages for a session.
 * Uses seq (per-session monotonic integer) as cursor — no collisions,
 * no NULLs, integer comparison. sent_at had 15K+ collisions in production.
 */
export function getMessages(
  db: Database.Database,
  sessionId: string,
  opts: { limit: number; before?: number; after?: number }
): MessageRow[] {
  if (opts.before) {
    // Load older: fetch N messages before seq, then re-sort ascending
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM session_messages
        WHERE session_id = ? AND seq < ?
        ORDER BY seq DESC
        LIMIT ?
      ) sub ORDER BY seq ASC
    `).all(sessionId, opts.before, opts.limit) as MessageRow[];
  }

  if (opts.after) {
    // Load newer: fetch N messages after seq, already in ascending order
    return db.prepare(`
      SELECT * FROM session_messages
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(sessionId, opts.after, opts.limit) as MessageRow[];
  }

  // Default: load latest N messages (DESC then re-wrap ASC)
  return db.prepare(`
    SELECT * FROM (
      SELECT * FROM session_messages
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    ) sub ORDER BY seq ASC
  `).all(sessionId, opts.limit) as MessageRow[];
}

export function hasOlderMessages(
  db: Database.Database,
  sessionId: string,
  seq: number
): boolean {
  return !!db.prepare(
    'SELECT 1 FROM session_messages WHERE session_id = ? AND seq < ? LIMIT 1'
  ).get(sessionId, seq);
}

export function hasNewerMessages(
  db: Database.Database,
  sessionId: string,
  seq: number
): boolean {
  return !!db.prepare(
    'SELECT 1 FROM session_messages WHERE session_id = ? AND seq > ? LIMIT 1'
  ).get(sessionId, seq);
}

export function getLastAssistantSdkMessageId(
  db: Database.Database,
  sessionId: string
): string | null {
  const row = db.prepare(`
    SELECT sdk_message_id FROM session_messages
    WHERE session_id = ? AND role = 'assistant' AND sdk_message_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId) as { sdk_message_id: string } | undefined;
  return row?.sdk_message_id ?? null;
}

export function getMessageById(
  db: Database.Database,
  id: string
): MessageRow | undefined {
  return db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as MessageRow | undefined;
}

export function getLatestUserMessage(
  db: Database.Database,
  sessionId: string
): MessageRow | undefined {
  return db.prepare(`
    SELECT * FROM session_messages
    WHERE session_id = ? AND role = 'user' AND cancelled_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId) as MessageRow | undefined;
}

// ─── Repo Queries ────────────────────────────────────────────

export function getAllRepos(db: Database.Database): RepoWithCountsRow[] {
  return db.prepare(`
    SELECT r.*,
           COUNT(CASE WHEN w.state = 'ready' THEN 1 END) as ready_count,
           COUNT(CASE WHEN w.state = 'archived' THEN 1 END) as archived_count,
           COUNT(w.id) as total_count
    FROM repos r
    LEFT JOIN workspaces w ON w.repository_id = r.id
    GROUP BY r.id
    ORDER BY r.display_order, r.created_at DESC
  `).all() as RepoWithCountsRow[];
}

export function getRepoById(
  db: Database.Database,
  id: string
): RepoRow | undefined {
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
}

export function getRepoByRootPath(
  db: Database.Database,
  rootPath: string
): RepoRow | undefined {
  return db.prepare('SELECT * FROM repos WHERE root_path = ?').get(rootPath) as RepoRow | undefined;
}

export function getMaxRepoDisplayOrder(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(display_order) as max FROM repos').get() as { max: number | null };
  return row?.max ?? 0;
}

// ─── Stats Queries ───────────────────────────────────────────

export function getStats(db: Database.Database): StatsRow {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM workspaces) as workspaces,
      (SELECT COUNT(*) FROM workspaces WHERE state = 'ready') as workspaces_ready,
      (SELECT COUNT(*) FROM workspaces WHERE state = 'archived') as workspaces_archived,
      (SELECT COUNT(*) FROM repos) as repos,
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM sessions WHERE status = 'idle') as sessions_idle,
      (SELECT COUNT(*) FROM sessions WHERE status = 'working') as sessions_working,
      (SELECT COUNT(*) FROM session_messages) as messages
  `).get() as StatsRow;
}

// ─── Settings Queries ────────────────────────────────────────

export function getAllSettingRows(db: Database.Database): SettingRow[] {
  return db.prepare('SELECT key, value, updated_at FROM settings').all() as SettingRow[];
}
