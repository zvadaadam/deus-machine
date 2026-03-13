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

