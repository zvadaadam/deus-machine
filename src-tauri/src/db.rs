/**
 * Database Manager — direct SQLite reads via rusqlite.
 *
 * Provides typed, low-latency DB reads for hot-path queries.
 * Frontend calls these through Tauri IPC (~1ms) instead of
 * HTTP → Node.js → SQLite → HTTP (~50-200ms).
 *
 * Uses rusqlite (already in Cargo.toml for cookie sync).
 * Connection is held behind Mutex — commands never hold the
 * lock across await points.
 */
use std::sync::Mutex;

// ─── DbManager ──────────────────────────────────────────────

pub struct DbManager {
    conn: Mutex<Option<rusqlite::Connection>>,
}

impl DbManager {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }

    /// Open the database at `path` with WAL mode + read-only optimizations.
    pub fn open(&self, path: &str) -> Result<(), String> {
        let conn = rusqlite::Connection::open(path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        // Match the WAL + busy_timeout settings used by backend and sidecar
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;"
        )
        .map_err(|e| format!("Failed to set PRAGMA: {}", e))?;

        let mut guard = self.conn.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        *guard = Some(conn);
        Ok(())
    }

    /// Run a closure with a reference to the connection.
    /// Locks the mutex, calls `f`, maps errors to String for Tauri.
    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<T, rusqlite::Error>,
    {
        let guard = self.conn.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        let conn = guard.as_ref().ok_or("Database not opened")?;
        f(conn).map_err(|e| format!("Database error: {}", e))
    }
}

// ─── Row Structs ────────────────────────────────────────────
// Mirror backend/src/db/types.ts — only include fields the frontend needs.

#[derive(serde::Serialize, Debug)]
pub struct WorkspaceWithDetails {
    pub id: String,
    pub repository_id: String,
    pub directory_name: String,
    pub display_name: Option<String>,
    pub branch: Option<String>,
    pub state: String,
    pub active_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub parent_branch: Option<String>,
    // Setup tracking (hive.json manifest) — parity with Node.js getWorkspacesByRepo
    pub setup_status: Option<String>,
    pub setup_error: Option<String>,
    pub init_step: Option<String>,
    // From repos JOIN
    pub repo_name: Option<String>,
    pub root_path: Option<String>,
    pub default_branch: Option<String>,
    pub repo_display_order: Option<i64>,
    // From sessions JOIN (null when no active session)
    pub session_status: Option<String>,
    pub model: Option<String>,
    pub latest_message_sent_at: Option<String>,
    // Computed in Rust
    pub workspace_path: String,
}

#[derive(serde::Serialize, Debug)]
pub struct RepoGroup {
    pub repo_id: String,
    pub repo_name: String,
    pub display_order: i64,
    pub workspaces: Vec<WorkspaceWithDetails>,
}

#[derive(serde::Serialize, Debug)]
pub struct SessionWithDetails {
    pub id: String,
    pub workspace_id: String,
    pub agent_type: String,
    pub title: Option<String>,
    pub status: String,
    pub model: String,
    pub sdk_session_id: Option<String>,
    pub message_count: i64,
    pub error_message: Option<String>,
    pub last_user_message_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // From JOINs
    pub directory_name: Option<String>,
    pub workspace_state: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: Option<String>,
    pub turn_id: Option<String>,
    pub created_at: String,
    pub sent_at: Option<String>,
    pub model: Option<String>,
    pub sdk_message_id: Option<String>,
    pub cancelled_at: Option<String>,
}

#[derive(serde::Serialize, Debug)]
pub struct PaginatedMessages {
    pub messages: Vec<MessageRow>,
    pub has_older: bool,
    pub has_newer: bool,
}

#[derive(serde::Serialize, Debug)]
pub struct StatsRow {
    pub workspaces: i64,
    pub workspaces_ready: i64,
    pub workspaces_archived: i64,
    pub repos: i64,
    pub sessions: i64,
    pub sessions_idle: i64,
    pub sessions_working: i64,
    pub messages: i64,
}

// ─── Helpers ────────────────────────────────────────────────

/// Compute workspace filesystem path from DB fields.
/// Mirrors backend/src/middleware/workspace-loader.ts computeWorkspacePath.
/// All Hive workspaces live at {root_path}/.hive/{directory_name}.
pub fn compute_workspace_path(
    root_path: Option<&str>,
    directory_name: Option<&str>,
) -> String {
    let root = match root_path {
        Some(r) if !r.is_empty() => r,
        _ => return String::new(),
    };
    let dir = match directory_name {
        Some(d) if !d.is_empty() => d,
        _ => return String::new(),
    };

    let mut path = std::path::PathBuf::from(root);
    path.push(".hive");
    path.push(dir);
    path.to_string_lossy().to_string()
}
