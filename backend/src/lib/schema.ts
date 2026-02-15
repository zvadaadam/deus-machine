/**
 * Hive Database Schema v1
 *
 * Standalone schema — all tables created on first run.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * Tables: repos, workspaces, sessions, session_messages, settings
 * Indexes: 7
 * Triggers: 4 (auto-update updated_at)
 *
 * IMPORTANT: Keep in sync with sidecar/db/schema.ts
 */
export const SCHEMA_SQL = `
  -- Repositories tracked by the app
  CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    name TEXT,
    root_path TEXT,
    default_branch TEXT DEFAULT 'main',
    display_order INTEGER DEFAULT 0,
    storage_version INTEGER DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Git worktrees tied to repos
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    repository_id TEXT REFERENCES repos(id),
    directory_name TEXT,
    branch TEXT,
    placeholder_branch_name TEXT,
    state TEXT DEFAULT 'initializing',
    active_session_id TEXT,
    unread INTEGER DEFAULT 0,
    initialization_parent_branch TEXT,
    initialization_log_path TEXT,
    initialization_files_copied INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Agent sessions tied to workspaces
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    agent_type TEXT,
    title TEXT,
    status TEXT DEFAULT 'idle',
    is_compacting INTEGER DEFAULT 0,
    context_token_count INTEGER DEFAULT 0,
    unread_count INTEGER DEFAULT 0,
    last_user_message_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Chat messages within sessions
  CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    model TEXT,
    sdk_message_id TEXT,
    cancelled_at TEXT,
    last_assistant_message_id TEXT
  );

  -- App key-value settings
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_session_messages_sent_at ON session_messages(session_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_session_messages_cancelled_at ON session_messages(session_id, cancelled_at);
  CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_session_messages_session_role ON session_messages(session_id, role, created_at DESC);

  -- Auto-update triggers for updated_at columns
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
`;
