use tauri::State;
use crate::pty::PtyManager;
use crate::socket::SocketManager;
use crate::backend::BackendManager;
use std::path::Path;

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

//============================================================================
// UNIX SOCKET COMMANDS (Sidecar Communication)
//============================================================================

#[tauri::command]
pub fn connect_to_sidecar(
    socket_path: String,
    socket_manager: State<'_, SocketManager>,
) -> Result<String, String> {
    socket_manager.connect(socket_path.clone())?;
    Ok(format!("Connected to {}", socket_path))
}

#[tauri::command]
pub fn send_sidecar_message(
    message: String,
    socket_manager: State<'_, SocketManager>,
) -> Result<String, String> {
    socket_manager.send(message)?;
    Ok("Message sent".to_string())
}

#[tauri::command]
pub fn receive_sidecar_message(
    socket_manager: State<'_, SocketManager>,
) -> Result<String, String> {
    socket_manager.receive()
}

#[tauri::command]
pub fn disconnect_from_sidecar(
    socket_manager: State<'_, SocketManager>,
) -> Result<String, String> {
    socket_manager.disconnect()?;
    Ok("Disconnected".to_string())
}

#[tauri::command]
pub fn is_sidecar_connected(
    socket_manager: State<'_, SocketManager>,
) -> Result<bool, String> {
    Ok(socket_manager.is_connected())
}

//============================================================================
// BACKEND COMMANDS
//============================================================================

/// Get the dynamic port the backend is running on
#[tauri::command]
pub fn get_backend_port(
    backend_manager: State<'_, BackendManager>,
) -> Result<u16, String> {
    backend_manager
        .get_port()
        .ok_or_else(|| "Backend port not available yet".to_string())
}

//============================================================================
// APP DETECTION COMMANDS
//============================================================================

#[derive(serde::Serialize)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Get list of installed development apps on macOS
#[tauri::command]
pub fn get_installed_apps() -> Result<Vec<InstalledApp>, String> {
    let mut apps = Vec::new();

    // List of apps to check for (id, display name, app path)
    let app_checks = vec![
        ("cursor", "Cursor", "/Applications/Cursor.app"),
        ("vscode", "VS Code", "/Applications/Visual Studio Code.app"),
        ("windsurf", "Windsurf", "/Applications/Windsurf.app"),
        ("xcode", "Xcode", "/Applications/Xcode.app"),
        ("terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"),
    ];

    for (id, name, path) in app_checks {
        if Path::new(path).exists() {
            apps.push(InstalledApp {
                id: id.to_string(),
                name: name.to_string(),
                path: path.to_string(),
            });
        }
    }

    Ok(apps)
}

/// Open a workspace directory in a specific app
#[tauri::command]
pub async fn open_in_app(app_id: String, workspace_path: String) -> Result<String, String> {
    let command = match app_id.as_str() {
        "cursor" => format!("open -a Cursor '{}'", workspace_path),
        "vscode" => format!("open -a 'Visual Studio Code' '{}'", workspace_path),
        "windsurf" => format!("open -a Windsurf '{}'", workspace_path),
        "xcode" => format!("open -a Xcode '{}'", workspace_path),
        "terminal" => format!("open -a Terminal '{}'", workspace_path),
        _ => return Err(format!("Unknown app: {}", app_id)),
    };

    std::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .map_err(|e| format!("Failed to open app: {}", e))?;

    Ok(format!("Opened in {}", app_id))
}
