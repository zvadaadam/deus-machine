use crate::watcher::WatcherManager;

/// Start watching a workspace directory for file changes.
/// Events are emitted as "fs:changed" Tauri events.
#[tauri::command]
pub fn watch_workspace(
    workspace_path: String,
    watcher: tauri::State<'_, WatcherManager>,
) -> Result<(), String> {
    watcher.watch(&workspace_path)
}

/// Stop watching a workspace directory.
#[tauri::command]
pub fn unwatch_workspace(
    workspace_path: String,
    watcher: tauri::State<'_, WatcherManager>,
) -> Result<(), String> {
    watcher.unwatch(&workspace_path)
}

/// Check if a workspace is currently being watched.
#[tauri::command]
pub fn is_workspace_watched(
    workspace_path: String,
    watcher: tauri::State<'_, WatcherManager>,
) -> bool {
    watcher.is_watching(&workspace_path)
}

/// List all currently watched workspace paths (diagnostics).
#[tauri::command]
pub fn list_watched_workspaces(
    watcher: tauri::State<'_, WatcherManager>,
) -> Vec<String> {
    watcher.list_watched()
}
