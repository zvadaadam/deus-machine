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
        // Code Editors
        ("cursor", "Cursor", "/Applications/Cursor.app"),
        ("vscode", "VS Code", "/Applications/Visual Studio Code.app"),
        ("windsurf", "Windsurf", "/Applications/Windsurf.app"),
        ("zed", "Zed", "/Applications/Zed.app"),
        ("sublime", "Sublime Text", "/Applications/Sublime Text.app"),
        ("nova", "Nova", "/Applications/Nova.app"),

        // JetBrains IDEs
        ("webstorm", "WebStorm", "/Applications/WebStorm.app"),
        ("intellij", "IntelliJ IDEA", "/Applications/IntelliJ IDEA.app"),
        ("pycharm", "PyCharm", "/Applications/PyCharm.app"),
        ("phpstorm", "PhpStorm", "/Applications/PhpStorm.app"),
        ("rubymine", "RubyMine", "/Applications/RubyMine.app"),
        ("goland", "GoLand", "/Applications/GoLand.app"),
        ("clion", "CLion", "/Applications/CLion.app"),
        ("fleet", "Fleet", "/Applications/Fleet.app"),
        ("rider", "Rider", "/Applications/Rider.app"),
        ("androidstudio", "Android Studio", "/Applications/Android Studio.app"),

        // Apple IDEs
        ("xcode", "Xcode", "/Applications/Xcode.app"),

        // Terminals
        ("terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"),
        ("iterm", "iTerm", "/Applications/iTerm.app"),
        ("warp", "Warp", "/Applications/Warp.app"),
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
        // Code Editors
        "cursor" => format!("open -a Cursor '{}'", workspace_path),
        "vscode" => format!("open -a 'Visual Studio Code' '{}'", workspace_path),
        "windsurf" => format!("open -a Windsurf '{}'", workspace_path),
        "zed" => format!("open -a Zed '{}'", workspace_path),
        "sublime" => format!("open -a 'Sublime Text' '{}'", workspace_path),
        "nova" => format!("open -a Nova '{}'", workspace_path),

        // JetBrains IDEs
        "webstorm" => format!("open -a WebStorm '{}'", workspace_path),
        "intellij" => format!("open -a 'IntelliJ IDEA' '{}'", workspace_path),
        "pycharm" => format!("open -a PyCharm '{}'", workspace_path),
        "phpstorm" => format!("open -a PhpStorm '{}'", workspace_path),
        "rubymine" => format!("open -a RubyMine '{}'", workspace_path),
        "goland" => format!("open -a GoLand '{}'", workspace_path),
        "clion" => format!("open -a CLion '{}'", workspace_path),
        "fleet" => format!("open -a Fleet '{}'", workspace_path),
        "rider" => format!("open -a Rider '{}'", workspace_path),
        "androidstudio" => format!("open -a 'Android Studio' '{}'", workspace_path),

        // Apple IDEs
        "xcode" => format!("open -a Xcode '{}'", workspace_path),

        // Terminals
        "terminal" => format!("open -a Terminal '{}'", workspace_path),
        "iterm" => format!("open -a iTerm '{}'", workspace_path),
        "warp" => format!("open -a Warp '{}'", workspace_path),

        _ => return Err(format!("Unknown app: {}", app_id)),
    };

    std::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .output()
        .map_err(|e| format!("Failed to open app: {}", e))?;

    Ok(format!("Opened in {}", app_id))
}
