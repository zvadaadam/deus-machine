/**
 * File Watcher Module
 *
 * Filesystem watching via the `notify` crate for real-time file change detection.
 * Debounces rapid bursts (git checkout, agent file writes) and filters through
 * .gitignore rules before emitting Tauri events.
 *
 * ARCHITECTURE:
 * ```text
 * notify::RecommendedWatcher (FSEvents on macOS)
 *     -> raw events
 * WatcherManager (debounce + .gitignore filter)
 *     -> debounced batch
 * app_handle.emit("fs:changed", FileChangeEvent)
 *     -> Tauri event
 * useFileWatcher hook (frontend)
 *     -> invalidate
 * React Query cache -> UI updates instantly
 * ```
 *
 * DEBOUNCING:
 * - 500ms soft debounce after last event (captures agent write bursts)
 * - 2000ms hard cap from first event (prevents infinite deferral during git checkout)
 * - 100ms tick interval for flush checks
 *
 * LIFECYCLE:
 * - One watcher per workspace, only for active/visible workspaces
 * - Start via watch(), stop via unwatch(), cleanup via unwatch_all()
 * - Managed as Tauri state (like PtyManager, SocketManager)
 */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::thread;
use std::fs;

use notify::{RecommendedWatcher, RecursiveMode, Watcher, Config, Event, EventKind};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use parking_lot::RwLock;
use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Emitter};

use crate::files::FILE_SCANNER;

// Debounce timing constants
const SOFT_DEBOUNCE_MS: u64 = 500;
const HARD_CAP_MS: u64 = 2000;
const TICK_INTERVAL_MS: u64 = 100;

/// Event payload emitted to the frontend via Tauri events.
/// Kept minimal — the frontend uses this to invalidate caches,
/// not to rebuild the file tree from events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangeEvent {
    /// Workspace path (matches cache key used by FILE_SCANNER)
    pub workspace_path: String,
    /// Summary of what changed
    pub change_type: FileChangeType,
    /// Number of non-ignored files affected in this debounced batch
    pub affected_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeType {
    /// Files were created, modified, or deleted
    FilesChanged,
    /// Only metadata changed (permissions, timestamps)
    MetadataOnly,
}

/// Per-workspace watcher state
struct WatcherEntry {
    /// The notify watcher handle — dropping this stops watching
    _watcher: RecommendedWatcher,
    /// Canonicalized path being watched
    canonical_path: PathBuf,
    /// Cached gitignore matcher — built once on watch(), rebuilt when .gitignore changes
    gitignore: Option<Gitignore>,
}

/// Pending debounce state for a workspace
struct DebounceBatch {
    /// Paths that changed (pre-gitignore filter)
    raw_paths: Vec<PathBuf>,
    /// Whether any non-metadata events occurred
    has_content_changes: bool,
    /// When the first event in this batch arrived
    first_event_at: Instant,
    /// When the most recent event arrived
    last_event_at: Instant,
}

/// Manages filesystem watchers for active workspaces.
///
/// One watcher per workspace. Only watch workspaces the user is actively viewing.
/// Uses `notify` crate's `RecommendedWatcher` (FSEvents on macOS, inotify on Linux).
pub struct WatcherManager {
    /// Active watchers keyed by canonicalized workspace path
    watchers: Arc<RwLock<HashMap<PathBuf, WatcherEntry>>>,
    /// Pending debounce batches keyed by canonicalized workspace path
    pending: Arc<RwLock<HashMap<PathBuf, DebounceBatch>>>,
    /// App handle for emitting Tauri events
    app_handle: Arc<RwLock<Option<AppHandle>>>,
    /// Whether the debounce thread is running
    debounce_running: Arc<RwLock<bool>>,
}

impl WatcherManager {
    pub fn new() -> Self {
        Self {
            watchers: Arc::new(RwLock::new(HashMap::new())),
            pending: Arc::new(RwLock::new(HashMap::new())),
            app_handle: Arc::new(RwLock::new(None)),
            debounce_running: Arc::new(RwLock::new(false)),
        }
    }

    /// Store app handle for event emission.
    /// Called once during app setup (same pattern as PtyManager).
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// Start the debounce flush thread.
    /// Runs every 100ms, checks each pending batch and flushes when ready.
    pub fn start_debounce_thread(&self) {
        let mut running = self.debounce_running.write();
        if *running {
            return;
        }
        *running = true;
        drop(running);

        let watchers = self.watchers.clone();
        let pending = self.pending.clone();
        let app_handle = self.app_handle.clone();
        let debounce_running = self.debounce_running.clone();

        thread::spawn(move || {
            while *debounce_running.read() {
                thread::sleep(Duration::from_millis(TICK_INTERVAL_MS));

                let now = Instant::now();
                let mut to_flush: Vec<(PathBuf, DebounceBatch)> = Vec::new();

                // Check which batches are ready to flush
                {
                    let mut pending_map = pending.write();
                    let keys_to_remove: Vec<PathBuf> = pending_map
                        .iter()
                        .filter_map(|(path, batch)| {
                            let soft_expired = now.duration_since(batch.last_event_at)
                                >= Duration::from_millis(SOFT_DEBOUNCE_MS);
                            let hard_expired = now.duration_since(batch.first_event_at)
                                >= Duration::from_millis(HARD_CAP_MS);
                            if soft_expired || hard_expired {
                                Some(path.clone())
                            } else {
                                None
                            }
                        })
                        .collect();

                    for key in keys_to_remove {
                        if let Some(batch) = pending_map.remove(&key) {
                            to_flush.push((key, batch));
                        }
                    }
                }

                // Flush each ready batch (outside the pending lock)
                for (workspace_path, batch) in to_flush {
                    // Check if .gitignore itself changed — rebuild cache if so
                    let gitignore_changed = batch.raw_paths.iter().any(|p| {
                        p.file_name().and_then(|n| n.to_str()) == Some(".gitignore")
                    });
                    if gitignore_changed {
                        if let Some(entry) = watchers.write().get_mut(&workspace_path) {
                            entry.gitignore = build_gitignore(&workspace_path);
                        }
                    }

                    // Use cached gitignore from WatcherEntry (avoids re-parsing on every flush)
                    let cached_gi = watchers.read()
                        .get(&workspace_path)
                        .and_then(|e| e.gitignore.clone());
                    let filtered = filter_ignored_paths_with(
                        &workspace_path, &batch.raw_paths, cached_gi.as_ref(),
                    );
                    let affected_count = filtered.len();

                    if affected_count == 0 {
                        continue;
                    }

                    let change_type = if batch.has_content_changes {
                        FileChangeType::FilesChanged
                    } else {
                        FileChangeType::MetadataOnly
                    };

                    // Invalidate Rust-side file cache before emitting event
                    FILE_SCANNER.invalidate_cache(&workspace_path);

                    // Emit Tauri event
                    if let Some(handle) = app_handle.read().as_ref() {
                        let event = FileChangeEvent {
                            workspace_path: workspace_path.to_string_lossy().to_string(),
                            change_type,
                            affected_count,
                        };

                        if let Err(e) = handle.emit("fs:changed", &event) {
                            eprintln!("[Watcher] Failed to emit fs:changed event: {}", e);
                        }
                    }
                }
            }
        });
    }

    /// Start watching a workspace directory.
    ///
    /// Idempotent: calling with an already-watched path is a no-op.
    /// Creates a `RecommendedWatcher` scoped to the workspace root.
    pub fn watch(&self, workspace_path: &str) -> Result<(), String> {
        let input_path = Path::new(workspace_path);

        if !input_path.exists() {
            return Err(format!("Path does not exist: {}", workspace_path));
        }

        // Canonicalize for consistent keys (handles /var -> /private/var on macOS)
        let canonical = fs::canonicalize(input_path)
            .map_err(|e| format!("Failed to canonicalize path: {}", e))?;

        // Idempotent: skip if already watching
        if self.watchers.read().contains_key(&canonical) {
            return Ok(());
        }

        let pending = self.pending.clone();
        let canonical_for_callback = canonical.clone();

        // Create the watcher with event handler
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                match result {
                    Ok(event) => {
                        // Skip access events (reads)
                        if matches!(event.kind, EventKind::Access(_)) {
                            return;
                        }

                        let now = Instant::now();
                        let has_content = !matches!(event.kind, EventKind::Modify(
                            notify::event::ModifyKind::Metadata(_)
                        ));

                        let mut pending_map = pending.write();
                        let batch = pending_map
                            .entry(canonical_for_callback.clone())
                            .or_insert_with(|| DebounceBatch {
                                raw_paths: Vec::new(),
                                has_content_changes: false,
                                first_event_at: now,
                                last_event_at: now,
                            });

                        batch.raw_paths.extend(event.paths);
                        batch.last_event_at = now;
                        if has_content {
                            batch.has_content_changes = true;
                        }
                    }
                    Err(e) => {
                        eprintln!("[Watcher] Error for {:?}: {}", canonical_for_callback, e);
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // Start watching the directory recursively
        watcher
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch path: {}", e))?;

        let entry = WatcherEntry {
            _watcher: watcher,
            canonical_path: canonical.clone(),
            gitignore: build_gitignore(&canonical),
        };

        self.watchers.write().insert(canonical.clone(), entry);

        println!("[Watcher] Started watching: {:?}", canonical);
        Ok(())
    }

    /// Stop watching a workspace directory.
    /// Idempotent: calling with an unwatched path is a no-op.
    pub fn unwatch(&self, workspace_path: &str) -> Result<(), String> {
        let input_path = Path::new(workspace_path);
        let canonical = fs::canonicalize(input_path)
            .unwrap_or_else(|_| input_path.to_path_buf());

        if let Some(entry) = self.watchers.write().remove(&canonical) {
            // Drop pending batch for this workspace
            self.pending.write().remove(&canonical);
            println!("[Watcher] Stopped watching: {:?}", entry.canonical_path);
        }

        Ok(())
    }

    /// Stop all watchers. Called on app shutdown.
    pub fn unwatch_all(&self) {
        let count = self.watchers.read().len();
        self.watchers.write().clear();
        self.pending.write().clear();
        *self.debounce_running.write() = false;
        if count > 0 {
            println!("[Watcher] Stopped all {} watchers", count);
        }
    }

    /// List currently watched workspace paths (for diagnostics).
    pub fn list_watched(&self) -> Vec<String> {
        self.watchers
            .read()
            .keys()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    }

    /// Check if a specific workspace is being watched.
    pub fn is_watching(&self, workspace_path: &str) -> bool {
        let input_path = Path::new(workspace_path);
        let canonical = fs::canonicalize(input_path)
            .unwrap_or_else(|_| input_path.to_path_buf());
        self.watchers.read().contains_key(&canonical)
    }
}

impl Default for WatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a Gitignore matcher for a workspace path.
/// Reuses the `ignore` crate (same as FILE_SCANNER uses via WalkBuilder).
fn build_gitignore(workspace_path: &Path) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(workspace_path);

    // Add .gitignore in workspace root
    let gitignore_path = workspace_path.join(".gitignore");
    if gitignore_path.exists() {
        if let Some(err) = builder.add(gitignore_path) {
            eprintln!("[Watcher] Error reading .gitignore: {}", err);
        }
    }

    // Add .git/info/exclude if it exists
    let exclude_path = workspace_path.join(".git/info/exclude");
    if exclude_path.exists() {
        if let Some(err) = builder.add(exclude_path) {
            eprintln!("[Watcher] Error reading .git/info/exclude: {}", err);
        }
    }

    builder.build().ok()
}

/// Filter a batch of changed paths through .gitignore rules.
/// Returns only paths that are NOT ignored.
/// Uses a pre-built Gitignore when available (cached in WatcherEntry),
/// falls back to building from disk if not provided.
fn filter_ignored_paths_with(
    workspace_path: &Path,
    paths: &[PathBuf],
    cached_gitignore: Option<&Gitignore>,
) -> Vec<PathBuf> {
    let built;
    let gitignore = match cached_gitignore {
        Some(gi) => Some(gi),
        None => {
            built = build_gitignore(workspace_path);
            built.as_ref()
        }
    };

    paths
        .iter()
        .filter(|path| {
            // Always ignore .git directory changes
            if path.components().any(|c| c.as_os_str() == ".git") {
                return false;
            }

            // Check against .gitignore rules
            if let Some(gi) = gitignore {
                let relative = path.strip_prefix(workspace_path).unwrap_or(path);
                let is_dir = path.is_dir();

                // Check the path itself
                if gi.matched(relative, is_dir).is_ignore() {
                    return false;
                }

                // Also check parent directories — Gitignore::matched() doesn't
                // automatically reject children of ignored directories
                let mut ancestor = relative.to_path_buf();
                while let Some(parent) = ancestor.parent() {
                    if parent.as_os_str().is_empty() {
                        break;
                    }
                    if gi.matched(parent, true).is_ignore() {
                        return false;
                    }
                    ancestor = parent.to_path_buf();
                }

                true
            } else {
                true
            }
        })
        .cloned()
        .collect()
}

//============================================================================
// TESTS
//============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_watcher_manager_creation() {
        let manager = WatcherManager::new();
        assert!(manager.list_watched().is_empty());
    }

    #[test]
    fn test_watch_nonexistent_path() {
        let manager = WatcherManager::new();
        let result = manager.watch("/nonexistent/path/that/does/not/exist");
        assert!(result.is_err());
    }

    #[test]
    fn test_watch_and_unwatch() {
        let temp = TempDir::new().unwrap();
        let manager = WatcherManager::new();
        let path = temp.path().to_str().unwrap();

        manager.watch(path).unwrap();
        assert!(manager.is_watching(path));
        assert_eq!(manager.list_watched().len(), 1);

        manager.unwatch(path).unwrap();
        assert!(!manager.is_watching(path));
        assert!(manager.list_watched().is_empty());
    }

    #[test]
    fn test_watch_idempotent() {
        let temp = TempDir::new().unwrap();
        let manager = WatcherManager::new();
        let path = temp.path().to_str().unwrap();

        manager.watch(path).unwrap();
        manager.watch(path).unwrap(); // Should not error
        assert_eq!(manager.list_watched().len(), 1);
    }

    #[test]
    fn test_unwatch_nonexistent_is_noop() {
        let manager = WatcherManager::new();
        let result = manager.unwatch("/some/nonexistent/path");
        assert!(result.is_ok());
    }

    #[test]
    fn test_unwatch_all() {
        let temp1 = TempDir::new().unwrap();
        let temp2 = TempDir::new().unwrap();
        let manager = WatcherManager::new();

        manager.watch(temp1.path().to_str().unwrap()).unwrap();
        manager.watch(temp2.path().to_str().unwrap()).unwrap();
        assert_eq!(manager.list_watched().len(), 2);

        manager.unwatch_all();
        assert!(manager.list_watched().is_empty());
    }

    #[test]
    fn test_gitignore_filtering() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();

        // Create .gitignore
        fs::write(root.join(".gitignore"), "*.log\nnode_modules/\n").unwrap();
        fs::write(root.join("app.ts"), "code").unwrap();
        fs::write(root.join("debug.log"), "log").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/pkg.json"), "{}").unwrap();

        let paths = vec![
            root.join("app.ts"),
            root.join("debug.log"),
            root.join("node_modules/pkg.json"),
            root.join(".git/objects/abc123"),
        ];

        let filtered = filter_ignored_paths_with(root, &paths, None);

        // Only app.ts should pass through
        assert_eq!(filtered.len(), 1);
        assert!(filtered[0].ends_with("app.ts"));
    }

    #[test]
    fn test_git_directory_always_filtered() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();

        // No .gitignore — but .git should still be filtered
        let paths = vec![
            root.join(".git/HEAD"),
            root.join(".git/objects/pack/abc"),
            root.join("src/main.rs"),
        ];

        let filtered = filter_ignored_paths_with(root, &paths, None);

        assert_eq!(filtered.len(), 1);
        assert!(filtered[0].ends_with("src/main.rs"));
    }
}
