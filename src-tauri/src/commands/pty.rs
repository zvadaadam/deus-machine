use tauri::State;
use crate::pty::PtyManager;

#[tauri::command]
pub async fn spawn_pty(
    pty_manager: State<'_, PtyManager>,
    id: String,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    pty_manager
        .spawn(id, command, args, cols, rows, cwd)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resize_pty(
    pty_manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_manager
        .resize(&id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_to_pty(
    pty_manager: State<'_, PtyManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    pty_manager
        .write(&id, data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kill_pty(
    pty_manager: State<'_, PtyManager>,
    id: String,
) -> Result<(), String> {
    pty_manager
        .kill(&id)
        .map_err(|e| e.to_string())
}
