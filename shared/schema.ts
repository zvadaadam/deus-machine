/**
 * Deus Database Schema — Single source of truth.
 *
 * Imported by backend/src/lib/database.ts.
 * All statements are idempotent (IF NOT EXISTS).
 *
 * Tables: repositories, workspaces, sessions, messages, turns, parts, compactions,
 *         paired_devices, assistants, automations, automation_runs,
 *         extension_installations, integration_connections
 * Indexes: 19
 * Triggers: 11 (2 valid project rows, 4 auto-update updated_at, 2 denormalized message_count + auto-seq, 1 chat number, 2 turn end order)
 *
 * The agent-facing tables (messages, turns, parts, compactions) store the
 * @zvada/agent-server protocol verbatim: `parts.data` is the engine `Part`
 * (lowercase type, epoch-ms times), `parts.type` is the engine part type, and
 * `compactions` is the `session.compaction` entity. No deus dialect.
 */

/**
 * Schema policy. SCHEMA_SQL is the whole schema, never a migration replay. To
 * add a column, put it in SCHEMA_SQL and, if existing databases should keep
 * working, in ADDITIVE_COLUMNS (nullable or defaulted). Any other difference
 * is a reset: at startup the backend compares the database with SCHEMA_SQL and
 * stops with PRELAUNCH_SCHEMA_RESET_HINT, naming the table and column.
 */
export const PRELAUNCH_SCHEMA_MISMATCH =
  "Database schema is out of date for this pre-launch build.";
export const PRELAUNCH_SCHEMA_RESET_HINT =
  "This database uses an older pre-launch schema. To start fresh and keep your old chats, run `deus start --data-dir /path/to/a/new/folder`. If you run the backend directly, set DATABASE_PATH to a fresh file.";

/** Columns ALTERed into an existing database that lacks them (each is in SCHEMA_SQL too). */
export const ADDITIVE_COLUMNS: Record<string, Record<string, string>> = {
  workspaces: { started_by: "TEXT", first_session_id: "TEXT", archived_by: "TEXT" },
  sessions: {
    gateway_revision: "TEXT",
    started_by: "TEXT",
    chat: "INTEGER",
    agent_messages: "INTEGER",
  },
  turns: { cancelled_by: "TEXT", end_seq: "INTEGER" },
  messages: { origin: "TEXT", steer_id: "TEXT" },
};

export const SCHEMA_SQL = `
  -- Repositories tracked by the app (id = UUID7, embeds created_at). root_path is
  -- optional: a row without one is a project not on this computer, known by its
  -- GitHub git_origin_url, that runs only in the cloud (SQLite allows several NULLs
  -- under UNIQUE).
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT UNIQUE,
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
    archived_by TEXT,
    setup_status TEXT NOT NULL DEFAULT 'none',
    init_stage TEXT,
    error_message TEXT,
    -- What the tool said when starting failed; error_message is the plain reason.
    error_detail TEXT,
    -- The branch the workspace was started from, so a retry starts from it again.
    git_source_branch TEXT,
    -- Why the fetch was skipped (no_origin) or failed (offline | auth | failed).
    -- NULL when fetched or when the source branch exists only locally.
    init_fetch_issue TEXT,
    kind TEXT NOT NULL DEFAULT 'worktree',
    provider_workspace_id TEXT,
    last_inline_mint_at INTEGER,
    -- The cloud organization a cloud workspace runs in (NULL for local, or not yet known).
    organization_id TEXT,
    -- Who started it, as the engine's origin (JSON); NULL is the person.
    started_by TEXT,
    -- Its first chat's id, minted when the workspace is created, until that chat's row exists.
    first_session_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Agent sessions tied to workspaces (id = UUID7, embeds created_at)
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- Engine harness id, as named in shared/harnesses.ts.
    agent_harness TEXT NOT NULL DEFAULT 'claude-code',
    agent_session_id TEXT,
    -- Whether the agent can message the person. NULL until its first ask.
    agent_messages INTEGER,
    gateway_revision TEXT,
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
    -- Who started it, as the engine's origin (JSON); NULL is the person.
    started_by TEXT,
    -- Its number in its workspace, from 1, in the order chats were made; never reused (trigger).
    chat INTEGER,
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
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,
    turn_id TEXT,
    model TEXT,
    sent_at TEXT,
    parent_tool_call_id TEXT,
    -- Who sent a user message when not the person, as the engine echoed it (JSON).
    origin TEXT,
    steer_id TEXT
  );

  -- One record per engine turn, including turns with no assistant output.
  -- No message owns these values; replay never moves or adds accounting.
  CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    execution TEXT,
    provider_credential_source TEXT,
    outcome TEXT,
    tokens TEXT,
    cost REAL,
    -- Who stopped it, as the engine's origin (JSON), when a stop named one.
    cancelled_by TEXT,
    -- The order its chat's turns ended in, from 1 (triggers): a reader's cursor carries it.
    end_seq INTEGER,
    PRIMARY KEY (session_id, turn_id)
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
    account_id TEXT,
    machine_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Hosted assistants (ChatGPT, Claude, a CLI agent) that signed in with the
  -- Deus account and reached this computer through Deus Cloud. Not paired
  -- devices: each request carries the account's own sign-in, which this
  -- computer verifies itself (services/assistants/). A first contact is
  -- 'pending' until the person allows it ('read' or 'operate') or denies it
  -- ('denied': kept, and refused at admission, until it is removed). One row
  -- per assistant, account and machine id: what a person allowed under one
  -- account is not allowed under another. name and host are labels only
  -- (Deus Cloud's name for the client and the host its sign-in returns to;
  -- else a readable form of its id, and a URL-shaped id's host). Times are
  -- epoch ms; last_seen_at is written at most once a minute.
  CREATE TABLE IF NOT EXISTS assistants (
    client_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT,
    access TEXT NOT NULL DEFAULT 'pending' CHECK (access IN ('pending', 'read', 'operate', 'denied')),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, account_id, machine_id)
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
    thinking_level TEXT,
    next_run_at TEXT,
    last_run_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT 'user',
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    -- The cloud organization it was listed under.
    organization_id TEXT,
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

  -- Apps, Plugins and Skills (shared/integrations/types.ts). One row per
  -- installed item, account-wide on this computer: every project and
  -- workspace inherits them, so there are no per-workspace rows.
  -- definition: the user's own app/skill (JSON), which is what makes an item
  -- "custom"; catalog items read theirs from the catalog and store none.
  -- explicit = the user installed it directly; an item a
  -- plugin brought in has explicit = 0 and goes when no installed plugin
  -- lists it (which plugins do is derived from the catalog, never stored).
  -- connection_id: the account an app's tools use.
  -- Skills: installed_ref (the commit on disk), status, and error (why the
  -- install or update failed).
  -- Apps: tools (JSON, what its server listed at the last check), checked_at,
  -- and error (what that check could not do).
  CREATE TABLE IF NOT EXISTS extension_installations (
    kind TEXT NOT NULL CHECK (kind IN ('app', 'skill', 'plugin')),
    item_id TEXT NOT NULL,
    definition TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    explicit INTEGER NOT NULL DEFAULT 1,
    connection_id TEXT REFERENCES integration_connections(id) ON DELETE SET NULL,
    installed_ref TEXT,
    status TEXT CHECK (status IS NULL OR status IN ('installing', 'ready', 'error')),
    error TEXT,
    tools TEXT,
    checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, item_id)
  );

  -- An app's account. kind says how it is held: 'oauth' (tokens from the MCP
  -- sign-in) and 'secret' (a pasted key, a local server's variables) keep a
  -- vault-sealed credential here (services/integrations/vault.ts) that never
  -- leaves the backend; 'cli' stores nothing (a CLI signed in on this
  -- computer supplies the token at each use); 'managed' is held by Deus Cloud
  -- for deus_account_id, has no credential, and counts only while that Deus
  -- account is the one signed in. last_error is the account's own problem (a
  -- refused refresh, a rejected key). An app uses one account today; the
  -- table keeps one row per account so a second (a second brand, work and
  -- personal) is a row, not a migration. 'removing' is a managed row the
  -- person removed: it belongs to no app any more, and stays until Deus Cloud
  -- has disconnected the account (at once, or when it can next be asked).
  CREATE TABLE IF NOT EXISTS integration_connections (
    id TEXT PRIMARY KEY NOT NULL,
    app_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('oauth', 'secret', 'cli', 'managed')),
    deus_account_id TEXT,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'needs_reauth', 'removing')),
    credential TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((kind = 'managed') = (deus_account_id IS NOT NULL))
  );

  -- Indexes (19)
  CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_state ON workspaces(state);
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(session_id, sent_at);
  CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role, id DESC);
  -- Groups message pages by turn and finds turns with no message rows.
  CREATE INDEX IF NOT EXISTS idx_messages_turn_id ON messages(session_id, turn_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_steer_id ON messages(session_id, steer_id) WHERE steer_id IS NOT NULL;
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
  CREATE INDEX IF NOT EXISTS idx_integration_connections_app ON integration_connections(app_id);

  -- Triggers also apply to existing databases, without rewriting existing projects.
  CREATE TRIGGER IF NOT EXISTS validate_project_insert BEFORE INSERT ON repositories
    WHEN NEW.name = '' OR NEW.root_path = ''
    BEGIN SELECT RAISE(ABORT, 'A project needs a name and a non-empty folder when local'); END;
  CREATE TRIGGER IF NOT EXISTS validate_project_update BEFORE UPDATE OF name, root_path ON repositories
    WHEN NEW.name = '' OR NEW.root_path = ''
    BEGIN SELECT RAISE(ABORT, 'A project needs a name and a non-empty folder when local'); END;

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

  -- A chat's number in its workspace, in the order made, hidden ones counted
  CREATE TRIGGER IF NOT EXISTS assign_session_chat
    AFTER INSERT ON sessions WHEN NEW.chat IS NULL
    BEGIN
      UPDATE sessions
        SET chat = (SELECT COALESCE(MAX(s.chat), 0) + 1 FROM sessions s WHERE s.workspace_id = NEW.workspace_id AND s.id != NEW.id)
        WHERE id = NEW.id;
    END;

  -- The order a chat's turns ended in, set once when a turn's end is first written
  CREATE TRIGGER IF NOT EXISTS assign_turn_end_seq_on_insert
    AFTER INSERT ON turns WHEN NEW.ended_at IS NOT NULL AND NEW.end_seq IS NULL
    BEGIN
      UPDATE turns SET end_seq = (SELECT COALESCE(MAX(t.end_seq), 0) + 1 FROM turns t WHERE t.session_id = NEW.session_id)
        WHERE session_id = NEW.session_id AND turn_id = NEW.turn_id;
    END;

  CREATE TRIGGER IF NOT EXISTS assign_turn_end_seq_on_end
    AFTER UPDATE OF ended_at ON turns WHEN NEW.ended_at IS NOT NULL AND NEW.end_seq IS NULL
    BEGIN
      UPDATE turns SET end_seq = (SELECT COALESCE(MAX(t.end_seq), 0) + 1 FROM turns t WHERE t.session_id = NEW.session_id)
        WHERE session_id = NEW.session_id AND turn_id = NEW.turn_id;
    END;

  CREATE TRIGGER IF NOT EXISTS dec_session_message_count
    AFTER DELETE ON messages
    BEGIN UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id; END;
`;

/**
 * Run after SCHEMA_SQL, and SCHEMA_SQL again after it (its updated_at
 * triggers are set aside meanwhile), in the same transaction, before anything
 * can insert:
 * turns that ended before their end order was stored get one, by when they
 * ended; chats from before stored numbers are numbered in the order the app showed
 * their tabs (by id, the creation order), hidden ones included, after any
 * number their workspace already has; and each workspace gets its first
 * chat's id from that same order. A database already done is left as it is.
 */
export const BACKFILL_SQL = `
  -- Not "updated now": the sidebar orders by updated_at. SCHEMA_SQL makes them again after.
  DROP TRIGGER IF EXISTS update_sessions_updated_at;
  DROP TRIGGER IF EXISTS update_workspaces_updated_at;

  UPDATE sessions SET chat = ranked.n FROM (
    SELECT s.id, ROW_NUMBER() OVER (PARTITION BY s.workspace_id ORDER BY s.id) + COALESCE(m.top, 0) AS n
    FROM sessions s LEFT JOIN (SELECT workspace_id, MAX(chat) AS top FROM sessions GROUP BY workspace_id) m
      ON m.workspace_id = s.workspace_id
    WHERE s.chat IS NULL
  ) AS ranked WHERE sessions.id = ranked.id;

  UPDATE turns SET end_seq = ranked.n FROM (
    SELECT t.session_id, t.turn_id,
      ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.ended_at, t.turn_id) + COALESCE(m.top, 0) AS n
    FROM turns t LEFT JOIN (SELECT session_id, MAX(end_seq) AS top FROM turns GROUP BY session_id) m
      ON m.session_id = t.session_id
    WHERE t.ended_at IS NOT NULL AND t.end_seq IS NULL
  ) AS ranked WHERE turns.session_id = ranked.session_id AND turns.turn_id = ranked.turn_id;

  UPDATE workspaces SET first_session_id = f.id FROM (
    SELECT workspace_id, id FROM (
      SELECT workspace_id, id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY chat, id) AS r
      FROM sessions
    ) WHERE r = 1
  ) AS f WHERE workspaces.id = f.workspace_id AND workspaces.first_session_id IS NULL;
`;
