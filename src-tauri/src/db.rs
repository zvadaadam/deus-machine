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
    db_path: Mutex<Option<String>>,
}

impl DbManager {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            db_path: Mutex::new(None),
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

        // Store the path so we can derive preferences.json location
        let mut path_guard = self.db_path.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        *path_guard = Some(path.to_string());

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
    pub slug: String,
    pub title: Option<String>,
    pub git_branch: Option<String>,
    pub state: String,
    pub current_session_id: Option<String>,
    pub updated_at: String,
    pub git_target_branch: Option<String>,
    // Setup tracking (hive.json manifest) — parity with Node.js getWorkspacesByRepo
    pub setup_status: Option<String>,
    pub error_message: Option<String>,
    pub init_stage: Option<String>,
    // From repos JOIN
    pub repo_name: Option<String>,
    pub root_path: Option<String>,
    pub git_default_branch: Option<String>,
    pub repo_sort_order: Option<i64>,
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
    pub sort_order: i64,
    pub workspaces: Vec<WorkspaceWithDetails>,
}

#[derive(serde::Serialize, Debug)]
pub struct SessionWithDetails {
    pub id: String,
    pub workspace_id: String,
    pub agent_type: String,
    pub model: String,
    pub agent_session_id: Option<String>,
    pub title: Option<String>,
    pub status: String,
    pub message_count: i64,
    pub error_message: Option<String>,
    pub last_user_message_at: Option<String>,
    pub context_token_count: i64,
    pub context_used_percent: f64,
    pub is_hidden: bool,
    pub updated_at: String,
    // From JOINs
    pub slug: Option<String>,
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
    pub sent_at: Option<String>,
    pub model: Option<String>,
    pub agent_message_id: Option<String>,
    pub cancelled_at: Option<String>,
    pub parent_tool_use_id: Option<String>,
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
    pub repositories: i64,
    pub sessions: i64,
    pub sessions_idle: i64,
    pub sessions_working: i64,
    pub messages: i64,
}

// ─── Settings Reads (from preferences.json) ────────────────

impl DbManager {
    /// Read a single setting value from preferences.json (co-located with hive.db).
    /// Returns None if the key doesn't exist or the file is missing/invalid.
    pub fn read_setting(&self, key: &str) -> Result<Option<String>, String> {
        let path_guard = self.db_path.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        let db_path = match path_guard.as_ref() {
            Some(p) => p.clone(),
            None => return Ok(None),
        };
        drop(path_guard);

        let prefs_path = std::path::Path::new(&db_path)
            .parent()
            .map(|p| p.join("preferences.json"))
            .ok_or("Cannot derive preferences.json path")?;

        let content = match std::fs::read_to_string(&prefs_path) {
            Ok(c) => c,
            Err(_) => return Ok(None), // File doesn't exist yet
        };

        let json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(j) => j,
            Err(_) => return Ok(None), // Treat corrupt/invalid JSON same as missing file
        };

        match json.get(key) {
            Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
            Some(serde_json::Value::Bool(b)) => Ok(Some(b.to_string())),
            Some(serde_json::Value::Number(n)) => Ok(Some(n.to_string())),
            Some(serde_json::Value::Null) | None => Ok(None),
            Some(other) => Ok(Some(other.to_string())),
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────

/// Compute workspace filesystem path from DB fields.
/// Mirrors backend/src/middleware/workspace-loader.ts computeWorkspacePath.
/// All Hive workspaces live at {root_path}/.hive/{slug}.
pub fn compute_workspace_path(
    root_path: Option<&str>,
    slug: Option<&str>,
) -> String {
    let root = match root_path {
        Some(r) if !r.is_empty() => r,
        _ => return String::new(),
    };
    let s = match slug {
        Some(d) if !d.is_empty() => d,
        _ => return String::new(),
    };

    let mut path = std::path::PathBuf::from(root);
    path.push(".hive");
    path.push(s);
    path.to_string_lossy().to_string()
}
