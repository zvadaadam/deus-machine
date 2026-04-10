/**
 * Deus Database Schema — Single source of truth.
 *
 * Imported by backend/src/lib/schema.ts.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * Tables: repositories, workspaces, sessions, messages, paired_devices
 * Indexes: 10
 * Triggers: 5 (3 auto-update updated_at, 2 denormalized message_count + auto-seq)
 */

/**
 * Post-launch migrations.
 * Each statement is an ALTER TABLE ADD COLUMN that may already exist.
 * Run each individually — catch "duplicate column" errors and skip.
 * Runs AFTER SCHEMA_SQL so tables already exist.
 *
 * Currently empty — SCHEMA_SQL defines the full schema for fresh installs.
 * Add ALTER TABLE statements here when the schema changes post-launch.
 */
export const MIGRATIONS: string[] = [
  // sessions: structured error category for category-aware UI
  `ALTER TABLE sessions ADD COLUMN error_category TEXT`,
  // workspaces: Workflow status (backlog/in-progress/in-review/done/canceled)
  `ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'in-progress'`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status)`,
  // messages: unified Parts data (JSON) alongside legacy content column
  `ALTER TABLE messages ADD COLUMN parts TEXT`,
];

export const SCHEMA_SQL = `
  -- Repositories tracked by the app (id = UUID7, embeds created_at)
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    git_default_branch TEXT NOT NULL DEFAULT 'main',
    sort_order INTEGER NOT NULL DEFAULT 0,
    git_origin_url TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Git worktrees tied to repositories (id = UUID7, embeds created_at)
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT,
    git_branch TEXT,
    git_target_branch TEXT,
    state TEXT NOT NULL DEFAULT 'initializing',
    status TEXT NOT NULL DEFAULT 'in-progress',
    current_session_id TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    archive_commit TEXT,
    archived_at TEXT,
    setup_status TEXT NOT NULL DEFAULT 'none',
    init_stage TEXT,
    error_message TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Agent sessions tied to workspaces (id = UUID7, embeds created_at)
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT 'opus',
    agent_session_id TEXT,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    message_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    error_category TEXT,
    last_user_message_at TEXT,
    context_token_count INTEGER NOT NULL DEFAULT 0,
    context_used_percent REAL NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Chat messages within sessions (id = UUID7, embeds created_at; append-only, no updated_at)
  -- seq is a per-session monotonic integer for reliable cursor pagination.
  -- Auto-assigned by trigger — never set manually in INSERT.
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,
    content TEXT,
    turn_id TEXT,
    model TEXT,
    agent_message_id TEXT,
    sent_at TEXT,
    cancelled_at TEXT,
    parent_tool_use_id TEXT,
    parts TEXT
  );

  -- Paired devices for remote access authentication
  CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL DEFAULT 'Unknown Device',
    token_hash TEXT NOT NULL UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indexes (10)
  CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(session_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(session_id, turn_id);
  CREATE INDEX IF NOT EXISTS idx_messages_parent_tool_use ON messages(parent_tool_use_id);
  CREATE INDEX IF NOT EXISTS idx_paired_devices_token_hash ON paired_devices(token_hash);

  -- Triggers: auto-update updated_at (3)
  CREATE TRIGGER IF NOT EXISTS update_repositories_updated_at
    AFTER UPDATE ON repositories
    BEGIN UPDATE repositories SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_workspaces_updated_at
    AFTER UPDATE ON workspaces
    BEGIN UPDATE workspaces SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_sessions_updated_at
    AFTER UPDATE ON sessions
    BEGIN UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.id; END;

  -- Triggers: denormalized message_count + auto-seq on messages (2)
  CREATE TRIGGER IF NOT EXISTS assign_message_seq
    AFTER INSERT ON messages
    BEGIN
      UPDATE messages
        SET seq = (SELECT COALESCE(MAX(m.seq), 0) + 1 FROM messages m WHERE m.session_id = NEW.session_id AND m.id != NEW.id)
        WHERE id = NEW.id;
      UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
    END;

  CREATE TRIGGER IF NOT EXISTS dec_session_message_count
    AFTER DELETE ON messages
    BEGIN UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id; END;
`;
