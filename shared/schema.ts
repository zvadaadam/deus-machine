/**
 * Deus Database Schema — Single source of truth.
 *
 * Imported by backend/src/lib/database.ts.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * Tables: repositories, workspaces, sessions, messages, parts, compactions,
 *         paired_devices
 * Indexes: 15
 * Triggers: 5 (3 auto-update updated_at, 2 denormalized message_count + auto-seq)
 *
 * The agent-facing tables (messages, parts, compactions) store the
 * @zvada/agent-server protocol verbatim: `parts.data` is the engine `Part`
 * (lowercase type, epoch-ms times), `parts.type` is the engine part type, and
 * `compactions` is the `session.compaction` entity. No deus dialect.
 */

/**
 * Pre-launch schema policy.
 *
 * Deus has not launched yet, so SCHEMA_SQL is the source of truth. Breaking
 * schema changes should update SCHEMA_SQL directly. If a local dev database was
 * created by an older shape, reset it instead of preserving compatibility
 * baggage through replayed migrations.
 *
 * After launch, replace this with versioned, audited migrations before changing
 * persisted user data.
 */
export const PRELAUNCH_SCHEMA_RESET_HINT =
  "This local database was created with an older pre-launch schema. Reset it by deleting deus.db (or point DATABASE_PATH at a fresh file), then restart Deus.";

export const PRELAUNCH_REQUIRED_COLUMNS = {
  // pr_* columns are additive (see ADDITIVE_COLUMNS) and asserted here only
  // AFTER applyAdditiveColumns has run, so a failed ALTER surfaces at boot
  // with the reset hint instead of as a "no such column" error at first query.
  workspaces: [
    "status",
    "pr_state",
    "pr_is_draft",
    "pr_review_status",
    "pr_has_conflicts",
    "pr_ci_status",
    "pr_checked_at",
  ],
  sessions: ["agent_harness", "error_category"],
  // Protocol unification (engine 0.3.0): messages gained turn-level accounting
  // and the unified parent column; a database without them predates the switch
  // to canonical protocol vocabulary and must be reset.
  messages: ["parent_tool_call_id", "tokens", "cost", "turn_stop_reason"],
  parts: ["parent_tool_call_id"],
  compactions: ["compaction_id"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Columns a current database must NOT have. The mirror image of
 * PRELAUNCH_REQUIRED_COLUMNS: that catches a database too OLD to have gained a
 * column, this catches one too old to have SHED one. SQLite cannot drop a
 * column without a table rebuild, and pre-launch we reset rather than migrate.
 *
 * `messages.content` was the pre-parts render path, retired when messages moved
 * to engine `parts`. Any database that still has it also predates the engine
 * harness ids (`claude-code`/`codex-app-server` replacing `claude`/`codex`/
 * `codex-server`), so this one marker forces the reset that clears both.
 */
export const PRELAUNCH_RETIRED_COLUMNS = {
  messages: ["content"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Additive columns applied to existing databases via ALTER TABLE at startup.
 * Purely additive (nullable or defaulted) — no reset required, unlike
 * PRELAUNCH_REQUIRED_COLUMNS breaks. Keep in sync with SCHEMA_SQL.
 */
export const ADDITIVE_COLUMNS = {
  workspaces: {
    pr_state: "TEXT",
    pr_is_draft: "INTEGER NOT NULL DEFAULT 0",
    pr_review_status: "TEXT",
    pr_has_conflicts: "INTEGER NOT NULL DEFAULT 0",
    pr_ci_status: "TEXT",
    pr_checked_at: "TEXT",
  },
} as const satisfies Record<string, Record<string, string>>;

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
    pr_state TEXT,
    pr_is_draft INTEGER NOT NULL DEFAULT 0,
    pr_review_status TEXT,
    pr_has_conflicts INTEGER NOT NULL DEFAULT 0,
    pr_ci_status TEXT,
    pr_checked_at TEXT,
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
    -- Engine harness id (@zvada/agent-server): claude-code | codex-sdk | codex-app-server
    agent_harness TEXT NOT NULL DEFAULT 'claude-code',
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
  --
  -- One row per engine message.started — INCLUDING the user echo, which is the
  -- source of truth for user rows. Every message renders from its parts.
  -- turn_id groups a turn; parent_tool_call_id nests a subagent's output under
  -- the tool call that spawned it (same spelling as parts.parent_tool_call_id).
  -- tokens/cost/turn_stop_reason carry the TURN's outcome (turn.ended),
  -- written onto the turn's last top-level assistant message.
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,
    turn_id TEXT,
    model TEXT,
    sent_at TEXT,
    cancelled_at TEXT,
    parent_tool_call_id TEXT,
    tokens TEXT,
    cost REAL,
    turn_stop_reason TEXT
  );

  -- Parts: individual content units within a message.
  -- Each engine message.part snapshot → one UPSERT by part id (the engine's
  -- own id). data is the engine Part verbatim; type is its lowercase protocol
  -- type (text | reasoning | tool | image | file).
  CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    tool_call_id TEXT,
    tool_name TEXT,
    parent_tool_call_id TEXT
  );

  -- Compactions: the engine's session.compaction entity, an ID-addressed
  -- POSITIONAL marker rendered between the turn it belongs to and its
  -- successor. Upserted by compaction_id as status/summary advance.
  CREATE TABLE IF NOT EXISTS compactions (
    compaction_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger TEXT,
    pre_tokens INTEGER,
    post_tokens INTEGER,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  -- Indexes (15)
  CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(session_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role, id DESC);
  -- turn.ended resolves "the turn's last top-level assistant message" through
  -- this index (session_id, turn_id, seq DESC) — no scan per completed turn.
  CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(session_id, turn_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_parent_tool_call ON messages(parent_tool_call_id);
  CREATE INDEX IF NOT EXISTS idx_parts_message_id ON parts(message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_parts_session_type ON parts(session_id, type);
  CREATE INDEX IF NOT EXISTS idx_parts_tool_call_id ON parts(tool_call_id);
  CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_compactions_turn ON compactions(session_id, turn_id);
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
