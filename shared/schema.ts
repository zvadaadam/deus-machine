/**
 * Hive Database Schema v2 — Single source of truth.
 *
 * Imported by both backend/src/lib/schema.ts and sidecar/db/schema.ts.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * Tables: repos, workspaces, sessions, session_messages, attachments, diff_comments, settings
 * Indexes: 10
 * Triggers: 7 (5 auto-update updated_at, 2 denormalized message_count + auto-seq)
 */
/**
 * V1 → V2 migrations.
 * Each statement is an ALTER TABLE ADD COLUMN that may already exist.
 * Run each individually — catch "duplicate column" errors and skip.
 * Must execute BEFORE SCHEMA_SQL so new indexes/triggers find the columns.
 */
export const V2_MIGRATIONS: string[] = [
  // session_messages: new columns
  `ALTER TABLE session_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE session_messages ADD COLUMN turn_id TEXT`,

  // sessions: new columns
  `ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT 'opus'`,
  `ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN error_message TEXT`,

  // workspaces: new columns
  `ALTER TABLE workspaces ADD COLUMN display_name TEXT`,
  `ALTER TABLE workspaces ADD COLUMN parent_branch TEXT`,
  `ALTER TABLE workspaces ADD COLUMN pr_url TEXT`,
  `ALTER TABLE workspaces ADD COLUMN pr_number INTEGER`,
  `ALTER TABLE workspaces ADD COLUMN archive_commit TEXT`,
  `ALTER TABLE workspaces ADD COLUMN archived_at TEXT`,

  // repos: new columns
  `ALTER TABLE repos ADD COLUMN github_url TEXT`,

  // workspaces: init pipeline tracking
  `ALTER TABLE workspaces ADD COLUMN init_step TEXT`,
];

/**
 * Backfill seq values for existing messages that have seq=0.
 * Uses ROW_NUMBER() to assign monotonic per-session ordering by created_at.
 * Safe to re-run — only updates rows where seq=0.
 */
export const V2_BACKFILL_SEQ = `
  UPDATE session_messages
  SET seq = sub.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at, id) AS rn
    FROM session_messages
    WHERE seq = 0
  ) AS sub
  WHERE session_messages.id = sub.id AND session_messages.seq = 0
`;

export const SCHEMA_SQL = `
  -- Repositories tracked by the app
  CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL DEFAULT 'main',
    display_order INTEGER NOT NULL DEFAULT 0,
    github_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Git worktrees tied to repos
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    directory_name TEXT NOT NULL,
    display_name TEXT,
    branch TEXT,
    parent_branch TEXT,
    state TEXT NOT NULL DEFAULT 'initializing',
    active_session_id TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    archive_commit TEXT,
    archived_at TEXT,
    init_step TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Agent sessions tied to workspaces
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL DEFAULT 'claude',
    title TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    model TEXT NOT NULL DEFAULT 'opus',
    sdk_session_id TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    last_user_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Chat messages within sessions (append-only, no updated_at)
  -- seq is a per-session monotonic integer for reliable cursor pagination.
  -- Auto-assigned by trigger — never set manually in INSERT.
  CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,
    content TEXT,
    turn_id TEXT,
    model TEXT,
    sdk_message_id TEXT,
    sent_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- File attachments on messages
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Code review comments on diffs
  CREATE TABLE IF NOT EXISTS diff_comments (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER,
    content TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- App key-value settings
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indexes (10)
  CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_session_messages_seq ON session_messages(session_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_session_messages_sent_at ON session_messages(session_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_session_messages_session_role ON session_messages(session_id, role, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_session_messages_turn_id ON session_messages(session_id, turn_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_diff_comments_workspace ON diff_comments(workspace_id, file_path);

  -- Triggers: auto-update updated_at (5)
  CREATE TRIGGER IF NOT EXISTS update_repos_updated_at
    AFTER UPDATE ON repos
    BEGIN UPDATE repos SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_workspaces_updated_at
    AFTER UPDATE ON workspaces
    BEGIN UPDATE workspaces SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_sessions_updated_at
    AFTER UPDATE ON sessions
    BEGIN UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_settings_updated_at
    AFTER UPDATE ON settings
    BEGIN UPDATE settings SET updated_at = datetime('now') WHERE key = NEW.key; END;

  CREATE TRIGGER IF NOT EXISTS update_diff_comments_updated_at
    AFTER UPDATE ON diff_comments
    BEGIN UPDATE diff_comments SET updated_at = datetime('now') WHERE id = NEW.id; END;

  -- Triggers: denormalized message_count + auto-seq on session_messages (2)
  CREATE TRIGGER IF NOT EXISTS assign_message_seq
    AFTER INSERT ON session_messages
    BEGIN
      UPDATE session_messages
        SET seq = (SELECT COALESCE(MAX(m.seq), 0) + 1 FROM session_messages m WHERE m.session_id = NEW.session_id AND m.id != NEW.id)
        WHERE id = NEW.id;
      UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
    END;

  CREATE TRIGGER IF NOT EXISTS dec_session_message_count
    AFTER DELETE ON session_messages
    BEGIN UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id; END;
`;
