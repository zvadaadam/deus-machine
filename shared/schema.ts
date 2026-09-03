/**
 * Deus Database Schema — Single source of truth.
 *
 * Imported by backend/src/lib/database.ts.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * Tables: repositories, workspaces, sessions, messages, parts, compactions,
 *         paired_devices, automations, automation_runs
 * Indexes: 17
 * Triggers: 6 (4 auto-update updated_at, 2 denormalized message_count + auto-seq)
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
  // Automations went cloud-only (agnt is the scheduler + source of truth;
  // these tables are its cache). A database with the locally-scheduled shape
  // predates that and must be reset.
  automations: ["environment", "synced_at"],
  automation_runs: ["provider_session_id"],
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
    // Cloud workspaces: where the files live + the agnt workspace backing them.
    kind: "TEXT NOT NULL DEFAULT 'worktree'",
    provider_workspace_id: "TEXT",
    // Epoch-ms of the last SUCCESSFUL inline App-token mint pushed into the
    // agnt DO's secret map. Lets the refresh path age-gate an UNKNOWN mint
    // outcome: a stored inline token past its 1-hour life only shadows the
    // org PAT, so it may be stripped even when the remint result is unknown.
    last_inline_mint_at: "INTEGER",
    // Cloud workspaces: the sandbox's public host template, e.g.
    // `https://{{port}}-<sandboxId>.e2b.app` (agnt streams it with the running
    // workspace state). The Browser tab substitutes a port to preview a dev
    // server running inside the sandbox.
    cloud_preview_template: "TEXT",
    // Cloud workspaces: the hosted simulator device (agnt's EAS Simulator),
    // mirrored from the platform's simulator.status events — the Simulator
    // tab renders from these. A status frame replaces all four; a NULL status
    // means no device was ever known. The stream URL is a capability URL like
    // cloud_preview_template: it must not outlive the sandbox (cleared when
    // the sandbox parks) or the account (cleared on identity change).
    cloud_sim_status: "TEXT",
    cloud_sim_platform: "TEXT",
    cloud_sim_stream_url: "TEXT",
    cloud_sim_error: "TEXT",
  },
  sessions: {
    // agnt session id for cloud-workspace sessions (null for local).
    provider_session_id: "TEXT",
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
    kind TEXT NOT NULL DEFAULT 'worktree',
    provider_workspace_id TEXT,
    last_inline_mint_at INTEGER,
    cloud_preview_template TEXT,
    cloud_sim_status TEXT,
    cloud_sim_platform TEXT,
    cloud_sim_stream_url TEXT,
    cloud_sim_error TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Agent sessions tied to workspaces (id = UUID7, embeds created_at)
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- Engine harness id (@zvada/agent-server): claude-code | codex-sdk | codex-app-server
    agent_harness TEXT NOT NULL DEFAULT 'claude-code',
    agent_session_id TEXT,
    provider_session_id TEXT,
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

  -- Automations: a prompt the agnt platform runs on a schedule, in a cloud
  -- sandbox, with the Mac open or closed. CLOUD-ONLY and a CACHE: the
  -- platform (agnt Postgres + the Automation Durable Object) is the source
  -- of truth — it schedules, executes, settles and auto-pauses; deus mirrors
  -- summaries through @deus-hq/sdk so the WS query layer stays synchronous.
  -- id = the agnt automation id verbatim. "name" is the DISPLAY name (the
  -- platform's mutable description; the org-unique platform name is a slug
  -- deus derives and never shows). "environment" is the spec's environment
  -- name — the repo link (repo-<slug>-<hash8>); repository_id resolves it to
  -- a local repo and stays NULL when the repo isn't on this machine, so no
  -- FK. workspace_id is the adopted deus row for the held sandbox.
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cron TEXT,
    timezone TEXT,
    environment TEXT NOT NULL,
    repository_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    paused_reason TEXT,
    session_policy TEXT NOT NULL DEFAULT 'fresh_session',
    model TEXT,
    next_run_at TEXT,
    last_run_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT 'user',
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The platform's run ledger, cached. id = the agnt run id.
  -- provider_session_id is the agnt session id (fresh_session runs derive
  -- sessionId === runId); session_id/workspace_id are the adopted deus rows,
  -- stamped when a run is opened in the app.
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY NOT NULL,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    trigger TEXT NOT NULL DEFAULT 'cron',
    provider_session_id TEXT,
    session_id TEXT,
    workspace_id TEXT,
    scheduled_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    stop_reason TEXT,
    error_message TEXT,
    cost REAL,
    summary TEXT
  );

  -- Indexes (17)
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
  CREATE INDEX IF NOT EXISTS idx_automations_repository_id ON automations(repository_id);
  -- Run history newest-first (agnt run ids are UUID7 — the PK carries time).
  CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, id DESC);

  -- Triggers: auto-update updated_at (4)
  CREATE TRIGGER IF NOT EXISTS update_repositories_updated_at
    AFTER UPDATE ON repositories
    BEGIN UPDATE repositories SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_workspaces_updated_at
    AFTER UPDATE ON workspaces
    BEGIN UPDATE workspaces SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_sessions_updated_at
    AFTER UPDATE ON sessions
    BEGIN UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.id; END;

  CREATE TRIGGER IF NOT EXISTS update_automations_updated_at
    AFTER UPDATE ON automations
    BEGIN UPDATE automations SET updated_at = datetime('now') WHERE id = NEW.id; END;

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
