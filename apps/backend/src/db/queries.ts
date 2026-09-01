/**
 * Typed query functions — centralized DB reads for all route handlers.
 *
 * Every `as` cast lives here (once per query), not in routes.
 * Route handlers call these functions instead of inline SQL.
 */
import type Database from "better-sqlite3";
import { decodePart } from "@zvada/agent-server/protocol";
import type { Part, UnknownPart } from "@shared/protocol-types";
import type {
  RepositoryRow,
  RepositoryWithCountsRow,
  WorkspaceRow,
  WorkspaceWithDetailsRow,
  SessionRow,
  SessionWithDetailsRow,
  MessageRow,
  MessageRowWithParts,
  PartRow,
  CompactionRow,
  StatsRow,
} from "./types";

// ─── Workspace Queries ───────────────────────────────────────

/**
 * Canonical workspace + repo + session column list and JOIN.
 * Single source of truth — reused by list, get-by-id, and by-repo queries
 * (by-repo appends repo_sort_order). Add new workspace columns HERE only.
 */
const WORKSPACE_ROW_COLUMNS = `
    w.id, w.repository_id, w.slug, w.title, w.git_branch,
    w.git_target_branch, w.kind, w.provider_workspace_id,
    w.state, w.status, w.current_session_id,
    w.pr_url, w.pr_number,
    w.pr_state, w.pr_is_draft, w.pr_review_status, w.pr_has_conflicts, w.pr_ci_status, w.pr_checked_at,
    w.setup_status, w.error_message, w.init_stage,
    w.updated_at,
    r.name as repo_name, r.root_path, r.git_default_branch, r.git_origin_url,
    s.status as session_status,
    s.error_category as session_error_category,
    s.error_message as session_error_message,
    s.last_user_message_at as latest_message_sent_at`;

const WORKSPACE_JOINS = `
  FROM workspaces w
  LEFT JOIN repositories r ON w.repository_id = r.id
  LEFT JOIN sessions s ON w.current_session_id = s.id
`;

const WORKSPACE_DETAILS_SELECT = `
  SELECT ${WORKSPACE_ROW_COLUMNS}
  ${WORKSPACE_JOINS}
`;

export function getAllWorkspaces(db: Database.Database): WorkspaceWithDetailsRow[] {
  return db
    .prepare(
      `
    ${WORKSPACE_DETAILS_SELECT}
    ORDER BY w.updated_at DESC
    LIMIT 100
  `
    )
    .all() as WorkspaceWithDetailsRow[];
}

export function getWorkspacesByRepo(
  db: Database.Database,
  state?: string
): WorkspaceWithDetailsRow[] {
  // Support comma-separated states (e.g. "ready,initializing")
  let stateFilter = "";
  let stateParams: string[] = [];
  if (state) {
    const states = state.split(",").map((s) => s.trim());
    stateFilter = `WHERE w.state IN (${states.map(() => "?").join(",")})`;
    stateParams = states;
  }
  return db
    .prepare(
      `
    SELECT ${WORKSPACE_ROW_COLUMNS},
      r.sort_order as repo_sort_order
    ${WORKSPACE_JOINS}
    ${stateFilter}
    ORDER BY r.sort_order, r.name, w.updated_at DESC
  `
    )
    .all(...stateParams) as WorkspaceWithDetailsRow[];
}

export function getWorkspaceById(
  db: Database.Database,
  id: string
): WorkspaceWithDetailsRow | undefined {
  return db
    .prepare(
      `
    ${WORKSPACE_DETAILS_SELECT}
    WHERE w.id = ?
  `
    )
    .get(id) as WorkspaceWithDetailsRow | undefined;
}

/** Used by withWorkspace middleware — lighter query without session JOIN. */
export function getWorkspaceForMiddleware(
  db: Database.Database,
  id: string
): WorkspaceWithDetailsRow | undefined {
  return db
    .prepare(
      `
    SELECT w.*, r.root_path, r.git_default_branch, r.name as repo_name
    FROM workspaces w
    LEFT JOIN repositories r ON w.repository_id = r.id
    WHERE w.id = ?
  `
    )
    .get(id) as WorkspaceWithDetailsRow | undefined;
}

export function getWorkspaceRaw(db: Database.Database, id: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
}

/**
 * Look up workspaces by their current session IDs.
 * Used by the query engine for delta pushes — when a session status changes,
 * we only need the affected workspace(s) instead of re-querying everything.
 */
export function getWorkspacesBySessionIds(
  db: Database.Database,
  sessionIds: string[]
): WorkspaceWithDetailsRow[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => "?").join(",");
  return db
    .prepare(
      `
    SELECT
      w.id, w.repository_id, w.slug, w.title, w.git_branch,
      w.git_target_branch, w.kind, w.provider_workspace_id,
      w.state, w.status, w.current_session_id,
      w.pr_url, w.pr_number,
      w.pr_state, w.pr_is_draft, w.pr_review_status, w.pr_has_conflicts, w.pr_ci_status, w.pr_checked_at,
      w.setup_status, w.error_message, w.init_stage,
      w.updated_at,
      r.name as repo_name, r.sort_order as repo_sort_order, r.root_path,
      r.git_default_branch, r.git_origin_url,
      s.status as session_status,
      s.error_category as session_error_category,
      s.error_message as session_error_message,
      s.last_user_message_at as latest_message_sent_at
    FROM workspaces w
    LEFT JOIN repositories r ON w.repository_id = r.id
    LEFT JOIN sessions s ON w.current_session_id = s.id
    WHERE w.current_session_id IN (${placeholders})
  `
    )
    .all(...sessionIds) as WorkspaceWithDetailsRow[];
}

/**
 * Non-archived workspaces for query engine and relay clients.
 * Used by: query-engine snapshots, relay initial state, relay data requests.
 */
export function getDashboardWorkspaces(db: Database.Database): WorkspaceWithDetailsRow[] {
  return db
    .prepare(
      `
    ${WORKSPACE_DETAILS_SELECT}
    WHERE w.state != 'archived'
    ORDER BY r.sort_order ASC, r.name ASC, w.updated_at DESC
  `
    )
    .all() as WorkspaceWithDetailsRow[];
}

// ─── Session Queries ─────────────────────────────────────────

/** Coerce SQLite INTEGER booleans (0/1) to JS booleans so HTTP and IPC return the same shape. */
function coerceSessionBooleans<T extends SessionRow>(row: T): T {
  return { ...row, is_hidden: Boolean(row.is_hidden) };
}

/**
 * Session query — uses denormalized message_count column
 * instead of COUNT(m.id) JOIN, eliminating expensive aggregation.
 */
// Two workspace joins with distinct meanings: `current_ws` is the workspace this
// session is the CURRENT session of (its slug/state surface only for the active
// session); `owner_ws` is the workspace this session belongs to (always present —
// the source of `workspace_kind`, which drives the direct render lane).
const SESSION_DETAILS_SELECT = `
  SELECT s.*, current_ws.slug, current_ws.state as workspace_state, owner_ws.kind as workspace_kind
  FROM sessions s
  LEFT JOIN workspaces current_ws ON s.id = current_ws.current_session_id
  LEFT JOIN workspaces owner_ws ON owner_ws.id = s.workspace_id
`;

export function getAllSessions(db: Database.Database): SessionWithDetailsRow[] {
  const rows = db
    .prepare(
      `
    ${SESSION_DETAILS_SELECT}
    ORDER BY s.updated_at DESC
    LIMIT 50
  `
    )
    .all() as SessionWithDetailsRow[];
  return rows.map(coerceSessionBooleans);
}

export function getSessionById(
  db: Database.Database,
  id: string
): SessionWithDetailsRow | undefined {
  const row = db
    .prepare(
      `
    ${SESSION_DETAILS_SELECT}
    WHERE s.id = ?
  `
    )
    .get(id) as SessionWithDetailsRow | undefined;
  return row ? coerceSessionBooleans(row) : undefined;
}

export function getSessionRaw(db: Database.Database, id: string): SessionRow | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? coerceSessionBooleans(row) : undefined;
}

/** All sessions for a workspace, ordered by creation time (UUID7 is chronological). */
export function getSessionsByWorkspaceId(db: Database.Database, workspaceId: string): SessionRow[] {
  const rows = db
    .prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY id ASC")
    .all(workspaceId) as SessionRow[];
  return rows.map(coerceSessionBooleans);
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
    return db
      .prepare(
        `
      SELECT * FROM (
        SELECT * FROM messages
        WHERE session_id = ? AND seq < ?
        ORDER BY seq DESC
        LIMIT ?
      ) sub ORDER BY seq ASC
    `
      )
      .all(sessionId, opts.before, opts.limit) as MessageRow[];
  }

  if (opts.after) {
    // Load newer: fetch N messages after seq, already in ascending order
    return db
      .prepare(
        `
      SELECT * FROM messages
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `
      )
      .all(sessionId, opts.after, opts.limit) as MessageRow[];
  }

  // Default: load latest N messages (DESC then re-wrap ASC)
  return db
    .prepare(
      `
    SELECT * FROM (
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    ) sub ORDER BY seq ASC
  `
    )
    .all(sessionId, opts.limit) as MessageRow[];
}

export function hasOlderMessages(db: Database.Database, sessionId: string, seq: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM messages WHERE session_id = ? AND seq < ? LIMIT 1")
    .get(sessionId, seq);
}

export function hasNewerMessages(db: Database.Database, sessionId: string, seq: number): boolean {
  return !!db
    .prepare("SELECT 1 FROM messages WHERE session_id = ? AND seq > ? LIMIT 1")
    .get(sessionId, seq);
}

/** Get the highest seq for a session (cursor initialization for real-time streaming). */
export function getMaxMessageSeq(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE session_id = ?")
    .get(sessionId) as { max_seq: number } | undefined;
  return row?.max_seq ?? 0;
}

/** Fetch all messages after a given seq (delta push for real-time streaming). */
export function getMessagesDelta(
  db: Database.Database,
  sessionId: string,
  afterSeq: number
): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC")
    .all(sessionId, afterSeq) as MessageRow[];
}

// ─── Parts Queries ──────────────────────────────────────────

/**
 * Batch-fetch parts for a set of message IDs.
 * Returns all parts ordered by message_id, seq (for stable ordering).
 * Uses SQLite's IN clause — safe for typical message page sizes (50-500).
 */
export function getPartsByMessageIds(db: Database.Database, messageIds: string[]): PartRow[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM parts WHERE message_id IN (${placeholders}) ORDER BY message_id, seq`)
    .all(...messageIds) as PartRow[];
}

/**
 * One stored `parts.data` payload → the runtime shape.
 *
 * The column holds the WIRE part (`persistPart` stores an unknown part's own
 * payload, not the `UnknownPart` wrapper the writing build decoded it into), so
 * the decode belongs HERE rather than being inherited from whoever wrote the
 * row. That is what makes the round trip honest in both directions: a type this
 * build still cannot read is re-wrapped into an `UnknownPart` with `raw`
 * intact — which is what every `"raw" in part` consumer narrows on — and a type
 * a LATER build learns is decoded properly out of rows an older one wrote.
 *
 * A decode failure is not a reason to lose the row. Parts carry no ordering
 * field, position IS the array index, so dropping one silently reorders
 * everything after it. Fall back to the parsed value — exactly what this read
 * path returned before it decoded anything.
 */
function decodeStoredPart(row: PartRow): Part | UnknownPart | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    console.error(`[attachParts] Failed to parse part ${row.id}:`, row.data?.slice(0, 100));
    return undefined;
  }
  try {
    return decodePart(parsed);
  } catch (error) {
    console.warn(`[attachParts] Part ${row.id} (${row.type}) did not decode:`, error);
    return parsed as Part;
  }
}

/**
 * Enrich message rows with the engine `Part` snapshots from the parts table.
 * Decodes the JSON `data` field once here so the frontend never sees PartRow.
 * Messages with no parts get an empty array.
 *
 * Parts carry NO ordering field of their own (position is the event's
 * knowledge, stored as `parts.seq`) — the array order IS the order, and the
 * query above already sorts by it.
 */
export function attachParts(db: Database.Database, messages: MessageRow[]): MessageRowWithParts[] {
  if (messages.length === 0) return [];

  const messageIds = messages.map((m) => m.id);
  const allParts = getPartsByMessageIds(db, messageIds);

  // Decode and group by message_id
  const partsByMessageId = new Map<string, Array<Part | UnknownPart>>();
  for (const row of allParts) {
    const part = decodeStoredPart(row);
    if (!part) continue;
    const existing = partsByMessageId.get(row.message_id);
    if (existing) {
      existing.push(part);
    } else {
      partsByMessageId.set(row.message_id, [part]);
    }
  }

  return messages.map((msg) => ({
    ...msg,
    parts: partsByMessageId.get(msg.id) ?? [],
  }));
}

/**
 * Every compaction marker for a session, oldest first. Bounded by the number
 * of compactions in one conversation (single digits), so no pagination —
 * it ships alongside the message page and the UI places each marker by its
 * turn.
 */
export function getCompactions(db: Database.Database, sessionId: string): CompactionRow[] {
  return db
    .prepare("SELECT * FROM compactions WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as CompactionRow[];
}

// ─── Repository Queries ─────────────────────────────────────

export function getAllRepositories(db: Database.Database): RepositoryWithCountsRow[] {
  return db
    .prepare(
      `
    SELECT r.*,
           COUNT(CASE WHEN w.state = 'ready' THEN 1 END) as ready_count,
           COUNT(CASE WHEN w.state = 'archived' THEN 1 END) as archived_count,
           COUNT(w.id) as total_count
    FROM repositories r
    LEFT JOIN workspaces w ON w.repository_id = r.id
    GROUP BY r.id
    ORDER BY r.sort_order, r.name
  `
    )
    .all() as RepositoryWithCountsRow[];
}

/** Lightweight repo list for backfilling empty groups in by-repo queries. */
export function getAllRepositorySummaries(
  db: Database.Database
): { id: string; name: string; sort_order: number; git_origin_url: string | null }[] {
  return db
    .prepare(
      "SELECT id, name, sort_order, git_origin_url FROM repositories ORDER BY sort_order, name"
    )
    .all() as { id: string; name: string; sort_order: number; git_origin_url: string | null }[];
}

export function getRepositoryById(db: Database.Database, id: string): RepositoryRow | undefined {
  return db.prepare("SELECT * FROM repositories WHERE id = ?").get(id) as RepositoryRow | undefined;
}

export function getRepositoryByRootPath(
  db: Database.Database,
  rootPath: string
): RepositoryRow | undefined {
  return db.prepare("SELECT * FROM repositories WHERE root_path = ?").get(rootPath) as
    | RepositoryRow
    | undefined;
}

export function getMaxRepositorySortOrder(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(sort_order) as max FROM repositories").get() as {
    max: number | null;
  };
  return row?.max ?? 0;
}

// ─── Stats Queries ───────────────────────────────────────────

let cachedStats: StatsRow | null = null;
let cachedAt = 0;
const STATS_TTL_MS = 5_000;

export function getStats(db: Database.Database): StatsRow {
  const now = Date.now();
  if (cachedStats && now - cachedAt < STATS_TTL_MS) return cachedStats;
  // Consolidated: 3 table scans (workspaces, sessions, scalar subqueries)
  // instead of 11 separate COUNT(*) subqueries.
  cachedStats = db
    .prepare(
      `
    SELECT
      w.workspaces, w.workspaces_ready, w.workspaces_archived,
      w.workspaces_backlog, w.workspaces_in_progress, w.workspaces_in_review,
      (SELECT COUNT(*) FROM repositories) as repositories,
      s.sessions, s.sessions_idle, s.sessions_working,
      (SELECT COUNT(*) FROM messages) as messages
    FROM (
      SELECT
        COUNT(*) as workspaces,
        COUNT(CASE WHEN state = 'ready' THEN 1 END) as workspaces_ready,
        COUNT(CASE WHEN state = 'archived' THEN 1 END) as workspaces_archived,
        COUNT(CASE WHEN status = 'backlog' AND state != 'archived' THEN 1 END) as workspaces_backlog,
        COUNT(CASE WHEN status = 'in-progress' AND state != 'archived' THEN 1 END) as workspaces_in_progress,
        COUNT(CASE WHEN status = 'in-review' AND state != 'archived' THEN 1 END) as workspaces_in_review
      FROM workspaces
    ) w, (
      SELECT
        COUNT(*) as sessions,
        COUNT(CASE WHEN status = 'idle' THEN 1 END) as sessions_idle,
        COUNT(CASE WHEN status = 'working' THEN 1 END) as sessions_working
      FROM sessions
    ) s
  `
    )
    .get() as StatsRow;
  cachedAt = now;
  return cachedStats;
}

/** Reset the in-memory stats cache (for testing). */
export function resetStatsCache(): void {
  cachedStats = null;
  cachedAt = 0;
}
