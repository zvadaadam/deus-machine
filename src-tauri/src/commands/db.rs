/**
 * Database Tauri Commands — hot-path reads via rusqlite.
 *
 * These bypass Node.js entirely for the 4 highest-frequency queries:
 * 1. db_get_workspaces_by_repo — sidebar workspace list (polled every 10s)
 * 2. db_get_stats — system statistics (polled every 30s)
 * 3. db_get_session — active session detail (polled every 2-5s)
 * 4. db_get_messages — chat messages with cursor pagination
 *
 * Each command takes State<DbManager>, runs a synchronous rusqlite query,
 * and returns typed structs that serialize directly to the frontend.
 */
use tauri::State;
use crate::db::{
    compute_workspace_path, DbManager, MessageRow, PaginatedMessages, RepoGroup,
    SessionWithDetails, StatsRow, WorkspaceWithDetails,
};

// ─── Helper: read a workspace row from a rusqlite Row ───────

fn read_workspace_row(row: &rusqlite::Row) -> Result<WorkspaceWithDetails, rusqlite::Error> {
    let id: String = row.get("id")?;
    let repository_id: String = row.get("repository_id")?;
    let directory_name: String = row.get("directory_name")?;
    let display_name: Option<String> = row.get("display_name")?;
    let branch: Option<String> = row.get("branch")?;
    let state: String = row.get("state")?;
    let active_session_id: Option<String> = row.get("active_session_id")?;
    let created_at: String = row.get("created_at")?;
    let updated_at: String = row.get("updated_at")?;
    let parent_branch: Option<String> = row.get("parent_branch")?;
    let repo_name: Option<String> = row.get("repo_name")?;
    let root_path: Option<String> = row.get("root_path")?;
    let default_branch: Option<String> = row.get("default_branch")?;
    let repo_display_order: Option<i64> = row.get("repo_display_order")?;
    let session_status: Option<String> = row.get("session_status")?;
    let model: Option<String> = row.get("model")?;
    let latest_message_sent_at: Option<String> = row.get("latest_message_sent_at")?;

    let workspace_path = compute_workspace_path(
        root_path.as_deref(),
        Some(directory_name.as_str()),
    );

    Ok(WorkspaceWithDetails {
        id,
        repository_id,
        directory_name,
        display_name,
        branch,
        state,
        active_session_id,
        created_at,
        updated_at,
        parent_branch,
        repo_name,
        root_path,
        default_branch,
        repo_display_order,
        session_status,
        model,
        latest_message_sent_at,
        workspace_path,
    })
}

// ─── 1. db_get_workspaces_by_repo ───────────────────────────

/// Fetch all workspaces grouped by repository.
/// Replaces GET /workspaces/by-repo (polled every 10s from sidebar).
/// Returns fully grouped RepoGroup[] — no post-processing in frontend.
#[tauri::command]
pub fn db_get_workspaces_by_repo(
    state: Option<String>,
    db: State<'_, DbManager>,
) -> Result<Vec<RepoGroup>, String> {
    db.with_conn(|conn| {
        // Keep parity with backend/src/db/queries.ts:
        // support comma-separated state filters (e.g. "ready,initializing").
        let state_values = state
            .as_deref()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty());

        let state_filter = state_values
            .as_ref()
            .map(|values| {
                let placeholders = (1..=values.len())
                    .map(|idx| format!("?{idx}"))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("WHERE w.state IN ({placeholders})")
            })
            .unwrap_or_default();

        let sql = format!(
            "SELECT
                w.id, w.repository_id, w.directory_name, w.display_name, w.branch, w.state,
                w.active_session_id, w.created_at, w.updated_at,
                w.parent_branch,
                r.name as repo_name, r.display_order as repo_display_order, r.root_path,
                r.default_branch,
                s.status as session_status, s.model,
                s.last_user_message_at as latest_message_sent_at
            FROM workspaces w
            LEFT JOIN repos r ON w.repository_id = r.id
            LEFT JOIN sessions s ON w.active_session_id = s.id
            {}
            ORDER BY r.display_order, r.name, w.updated_at DESC",
            state_filter
        );

        let mut stmt = conn.prepare(&sql)?;

        let rows: Vec<WorkspaceWithDetails> = if let Some(ref values) = state_values {
            let params = rusqlite::params_from_iter(values.iter());
            let mapped = stmt.query_map(params, |row| read_workspace_row(row))?;
            mapped.collect::<Result<Vec<_>, _>>()?
        } else {
            let mapped = stmt.query_map([], |row| read_workspace_row(row))?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };

        // Group by repository_id, preserving insertion order (already sorted by SQL).
        // Uses Vec<RepoGroup> + position lookup to avoid adding indexmap dependency.
        let mut result: Vec<RepoGroup> = Vec::new();
        let mut repo_positions: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();

        for ws in rows {
            let repo_id = ws.repository_id.clone();
            if let Some(&pos) = repo_positions.get(&repo_id) {
                result[pos].workspaces.push(ws);
            } else {
                let pos = result.len();
                repo_positions.insert(repo_id.clone(), pos);
                result.push(RepoGroup {
                    repo_id,
                    repo_name: ws.repo_name.clone().unwrap_or_else(|| "Unknown".to_string()),
                    display_order: ws.repo_display_order.unwrap_or(999),
                    workspaces: vec![ws],
                });
            }
        }

        // SQL already sorts by display_order, but sort again to be safe
        result.sort_by_key(|g| g.display_order);
        Ok(result)
    })
}

// ─── 2. db_get_stats ────────────────────────────────────────

/// Fetch system statistics.
/// Replaces GET /stats (polled every 30s).
/// Single query with 8 subqueries — matches backend/src/db/queries.ts getStats.
#[tauri::command]
pub fn db_get_stats(db: State<'_, DbManager>) -> Result<StatsRow, String> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM workspaces) as workspaces,
                (SELECT COUNT(*) FROM workspaces WHERE state = 'ready') as workspaces_ready,
                (SELECT COUNT(*) FROM workspaces WHERE state = 'archived') as workspaces_archived,
                (SELECT COUNT(*) FROM repos) as repos,
                (SELECT COUNT(*) FROM sessions) as sessions,
                (SELECT COUNT(*) FROM sessions WHERE status = 'idle') as sessions_idle,
                (SELECT COUNT(*) FROM sessions WHERE status = 'working') as sessions_working,
                (SELECT COUNT(*) FROM session_messages) as messages",
            [],
            |row| {
                Ok(StatsRow {
                    workspaces: row.get(0)?,
                    workspaces_ready: row.get(1)?,
                    workspaces_archived: row.get(2)?,
                    repos: row.get(3)?,
                    sessions: row.get(4)?,
                    sessions_idle: row.get(5)?,
                    sessions_working: row.get(6)?,
                    messages: row.get(7)?,
                })
            },
        )
    })
}

// ─── 3. db_get_session ──────────────────────────────────────

/// Fetch a single session with workspace details.
/// Uses denormalized message_count column instead of COUNT JOIN.
/// Replaces GET /sessions/:id (polled every 2-5s per active session).
#[tauri::command]
pub fn db_get_session(
    id: String,
    db: State<'_, DbManager>,
) -> Result<Option<SessionWithDetails>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT s.*, w.directory_name, w.state as workspace_state
             FROM sessions s
             LEFT JOIN workspaces w ON s.id = w.active_session_id
             WHERE s.id = ?1",
        )?;

        let result = stmt.query_row(rusqlite::params![id], |row| {
            Ok(SessionWithDetails {
                id: row.get("id")?,
                workspace_id: row.get("workspace_id")?,
                agent_type: row.get("agent_type")?,
                title: row.get("title")?,
                status: row.get("status")?,
                model: row.get("model")?,
                sdk_session_id: row.get("sdk_session_id")?,
                message_count: row.get("message_count")?,
                error_message: row.get("error_message")?,
                last_user_message_at: row.get("last_user_message_at")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
                directory_name: row.get("directory_name")?,
                workspace_state: row.get("workspace_state")?,
            })
        });

        match result {
            Ok(session) => Ok(Some(session)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    })
}

// ─── 4. db_get_messages ─────────────────────────────────────

/// Fetch paginated messages for a session with cursor-based pagination.
/// Replaces GET /sessions/:id/messages (polled every 2s in web mode).
/// Combines getMessages + hasOlderMessages + hasNewerMessages into one command.
/// Uses monotonic `seq` column for reliable cursors (no timestamp collisions).
#[tauri::command]
pub fn db_get_messages(
    session_id: String,
    limit: Option<i64>,
    before: Option<i64>,
    after: Option<i64>,
    db: State<'_, DbManager>,
) -> Result<PaginatedMessages, String> {
    let limit = limit.unwrap_or(50);

    db.with_conn(|conn| {
        let messages: Vec<MessageRow> = if let Some(before_seq) = before {
            // Fetch older messages (before cursor), then reverse for ASC order
            let mut stmt = conn.prepare(
                "SELECT * FROM (
                    SELECT * FROM session_messages
                    WHERE session_id = ?1 AND seq < ?2
                    ORDER BY seq DESC
                    LIMIT ?3
                ) sub ORDER BY seq ASC",
            )?;
            let mapped = stmt.query_map(
                rusqlite::params![session_id, before_seq, limit],
                read_message_row,
            )?;
            mapped.collect::<Result<Vec<_>, _>>()?
        } else if let Some(after_seq) = after {
            // Fetch newer messages (after cursor)
            let mut stmt = conn.prepare(
                "SELECT * FROM session_messages
                 WHERE session_id = ?1 AND seq > ?2
                 ORDER BY seq ASC
                 LIMIT ?3",
            )?;
            let mapped = stmt.query_map(
                rusqlite::params![session_id, after_seq, limit],
                read_message_row,
            )?;
            mapped.collect::<Result<Vec<_>, _>>()?
        } else {
            // Default: fetch latest messages
            let mut stmt = conn.prepare(
                "SELECT * FROM (
                    SELECT * FROM session_messages
                    WHERE session_id = ?1
                    ORDER BY seq DESC
                    LIMIT ?2
                ) sub ORDER BY seq ASC",
            )?;
            let mapped =
                stmt.query_map(rusqlite::params![session_id, limit], read_message_row)?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };

        // Determine has_older / has_newer from the returned message window
        let (has_older, has_newer) = if messages.is_empty() {
            (false, false)
        } else {
            let first_seq = messages.first().map(|m| m.seq);
            let last_seq = messages.last().map(|m| m.seq);

            let has_older = if let Some(seq) = first_seq {
                conn.query_row(
                    "SELECT 1 FROM session_messages WHERE session_id = ?1 AND seq < ?2 LIMIT 1",
                    rusqlite::params![session_id, seq],
                    |_| Ok(true),
                )
                .unwrap_or(false)
            } else {
                false
            };

            let has_newer = if let Some(seq) = last_seq {
                conn.query_row(
                    "SELECT 1 FROM session_messages WHERE session_id = ?1 AND seq > ?2 LIMIT 1",
                    rusqlite::params![session_id, seq],
                    |_| Ok(true),
                )
                .unwrap_or(false)
            } else {
                false
            };

            (has_older, has_newer)
        };

        Ok(PaginatedMessages {
            messages,
            has_older,
            has_newer,
        })
    })
}

fn read_message_row(row: &rusqlite::Row) -> Result<MessageRow, rusqlite::Error> {
    Ok(MessageRow {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        seq: row.get("seq")?,
        role: row.get("role")?,
        content: row.get("content")?,
        turn_id: row.get("turn_id")?,
        created_at: row.get("created_at")?,
        sent_at: row.get("sent_at")?,
        model: row.get("model")?,
        sdk_message_id: row.get("sdk_message_id")?,
        cancelled_at: row.get("cancelled_at")?,
    })
}
