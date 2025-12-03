use tauri::{Emitter, State};
use crate::pty::PtyManager;
use crate::socket::SocketManager;
use crate::backend::BackendManager;
use crate::browser::BrowserManager;
use crate::files::{FILE_SCANNER, FileTreeResponse};
use std::path::{Path, PathBuf};

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

// Shared app definitions (id, display name, app path)
const APP_DEFINITIONS: &[(&str, &str, &str)] = &[
    // Code Editors
    ("cursor", "Cursor", "/Applications/Cursor.app"),
    ("vscode", "Visual Studio Code", "/Applications/Visual Studio Code.app"),
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

/// Get list of installed development apps on macOS
#[tauri::command]
pub fn get_installed_apps() -> Result<Vec<InstalledApp>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Ok(Vec::new());
    }

    #[cfg(target_os = "macos")]
    {
        let mut apps = Vec::new();

        for (id, name, path) in APP_DEFINITIONS {
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
}

/// Open a workspace directory in a specific app
#[tauri::command]
pub fn open_in_app(app_id: String, workspace_path: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("This feature is only available on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // Find the app name from our shared definitions
        let app_name = APP_DEFINITIONS
            .iter()
            .find(|(id, _, _)| *id == app_id.as_str())
            .map(|(_, name, _)| *name)
            .ok_or_else(|| format!("Unknown app: {}", app_id))?;

        // Terminal apps need special handling via AppleScript
        let output = match app_id.as_str() {
            "terminal" => {
                let script = format!(
                    r#"tell application "Terminal"
                        activate
                        do script "cd '{}'"
                    end tell"#,
                    workspace_path.replace("'", "'\\''")
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| format!("Failed to open Terminal: {}", e))?
            }
            "iterm" => {
                let script = format!(
                    r#"tell application "iTerm"
                        activate
                        create window with default profile
                        tell current session of current window
                            write text "cd '{}'"
                        end tell
                    end tell"#,
                    workspace_path.replace("'", "'\\''")
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| format!("Failed to open iTerm: {}", e))?
            }
            "warp" => {
                let script = format!(
                    r#"tell application "Warp"
                        activate
                    end tell
                    do shell script "open -a Warp '{}'"#,
                    workspace_path.replace("'", "'\\''")
                );
                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| format!("Failed to open Warp: {}", e))?
            }
            // IDEs and editors work with standard open command
            _ => {
                std::process::Command::new("open")
                    .arg("-a")
                    .arg(app_name)
                    .arg(&workspace_path)
                    .output()
                    .map_err(|e| format!("Failed to open app: {}", e))?
            }
        };

        if !output.status.success() {
            return Err(format!(
                "Failed to open {}: {}",
                app_name,
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        Ok(format!("Opened in {}", app_name))
    }
}

//============================================================================
// BROWSER COMMANDS
//============================================================================

/// Start the dev-browser HTTP server
#[tauri::command]
pub fn start_browser_server(
    browser_path: String,
    browser_manager: State<'_, BrowserManager>,
) -> Result<String, String> {
    println!("[COMMAND] start_browser_server called with path: {}", browser_path);

    let path = PathBuf::from(&browser_path);

    // Verify path exists
    if !path.exists() {
        let error_msg = format!("Browser path does not exist: {}", browser_path);
        eprintln!("[COMMAND] {}", error_msg);
        return Err(error_msg);
    }

    println!("[COMMAND] Starting browser server at: {}", path.display());
    browser_manager
        .start(path)
        .map_err(|e| {
            let error_msg = format!("Failed to start browser server: {}", e);
            eprintln!("[COMMAND] {}", error_msg);
            error_msg
        })?;

    println!("[COMMAND] Browser server started successfully");
    Ok("Browser server started".to_string())
}

/// Stop the dev-browser HTTP server
#[tauri::command]
pub fn stop_browser_server(
    browser_manager: State<'_, BrowserManager>,
) -> Result<String, String> {
    browser_manager
        .stop()
        .map_err(|e| e.to_string())?;

    Ok("Browser server stopped".to_string())
}

/// Get the port the browser server is running on
#[tauri::command]
pub fn get_browser_port(
    browser_manager: State<'_, BrowserManager>,
) -> Result<u16, String> {
    browser_manager
        .get_port()
        .ok_or_else(|| "Browser server port not available".to_string())
}

/// Get the auth token for the browser server
#[tauri::command]
pub fn get_browser_auth_token(
    browser_manager: State<'_, BrowserManager>,
) -> Result<String, String> {
    browser_manager
        .get_auth_token()
        .ok_or_else(|| "Browser server auth token not available".to_string())
}

/// Check if browser server is running
#[tauri::command]
pub fn is_browser_running(
    browser_manager: State<'_, BrowserManager>,
) -> Result<bool, String> {
    Ok(browser_manager.is_running())
}

//============================================================================
// GIT COMMANDS
//============================================================================

#[derive(serde::Serialize, Clone)]
pub struct GitCloneProgress {
    pub percent: usize,
    pub received: usize,
    pub total: usize,
    pub received_bytes: usize,
    pub status: String,
    pub phase: String,
}

#[derive(serde::Serialize)]
pub struct GitCloneResult {
    pub path: String,
    pub name: String,
}

/// Clone a git repository to a target directory with progress events
#[tauri::command]
pub fn git_clone(
    url: String,
    target_path: String,
    app_handle: tauri::AppHandle,
) -> Result<GitCloneResult, String> {
    use git2::{build::RepoBuilder, ErrorCode, FetchOptions, RemoteCallbacks};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let target = PathBuf::from(&target_path);
    let folder_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repository")
        .to_string();

    if target.exists() {
        if target.is_dir() {
            let is_non_empty = std::fs::read_dir(&target)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);

            if is_non_empty {
                let git_dir = target.join(".git");
                if git_dir.exists() {
                    return Err(format!(
                        "\"{}\" already contains a git repository. Use \"Add Repository\" instead.",
                        folder_name
                    ));
                }
                return Err(format!(
                    "Folder \"{}\" already exists and is not empty",
                    folder_name
                ));
            }
        } else {
            return Err(format!("A file named \"{}\" already exists at this location", folder_name));
        }
    }

    let _ = app_handle.emit(
        "git-clone-progress",
        GitCloneProgress {
            percent: 0,
            received: 0,
            total: 0,
            received_bytes: 0,
            status: "Connecting...".to_string(),
            phase: "connecting".to_string(),
        },
    );

    let last_percent = Arc::new(AtomicUsize::new(0));
    let app = app_handle.clone();
    let mut callbacks = RemoteCallbacks::new();
    let progress_tracker = last_percent.clone();
    callbacks.transfer_progress(move |stats| {
        let total = stats.total_objects();
        let received = stats.received_objects();
        let indexed = stats.indexed_objects();
        let received_bytes = stats.received_bytes();
        let percent = if total > 0 {
            (received * 100) / total
        } else {
            0
        };

        let last = progress_tracker.load(Ordering::Relaxed);
        if percent != last {
            progress_tracker.store(percent, Ordering::Relaxed);

            let (phase, status) = if received < total {
                ("receiving".to_string(), "Receiving...".to_string())
            } else if indexed < received {
                ("indexing".to_string(), "Indexing...".to_string())
            } else {
                ("resolving".to_string(), "Resolving...".to_string())
            };

            let _ = app.emit(
                "git-clone-progress",
                GitCloneProgress {
                    percent,
                    received,
                    total,
                    received_bytes,
                    status,
                    phase,
                },
            );
        }
        true
    });

    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks);

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch_options);

    builder.clone(&url, &target).map_err(|e| {
        match e.code() {
            ErrorCode::NotFound => "Repository not found. Check the URL and try again.".to_string(),
            ErrorCode::Auth => "Authentication required. Check your credentials.".to_string(),
            ErrorCode::Exists => format!("Folder \"{}\" already exists", folder_name),
            _ => {
                let msg = e.message();
                if msg.contains("failed to resolve address") || msg.contains("Could not resolve host") {
                    "Could not connect. Check your internet connection.".to_string()
                } else if msg.contains("SSL") || msg.contains("certificate") {
                    "SSL/certificate error. Check your network settings.".to_string()
                } else {
                    format!("Clone failed: {}", msg)
                }
            }
        }
    })?;

    let _ = app_handle.emit(
        "git-clone-progress",
        GitCloneProgress {
            percent: 100,
            received: 0,
            total: 0,
            received_bytes: 0,
            status: "Complete".to_string(),
            phase: "complete".to_string(),
        },
    );

    Ok(GitCloneResult {
        path: target_path,
        name: folder_name,
    })
}

//============================================================================
// FILE SCANNING COMMANDS
//============================================================================

/// Scan workspace directory and return file tree
#[tauri::command]
pub fn scan_workspace_files(workspace_path: String) -> Result<FileTreeResponse, String> {
    println!("[COMMAND] scan_workspace_files: {}", workspace_path);

    FILE_SCANNER
        .scan_workspace(&workspace_path)
        .map_err(|e| {
            let error_msg = format!("Failed to scan workspace: {}", e);
            eprintln!("[COMMAND] {}", error_msg);
            error_msg
        })
}

/// Invalidate cache for a specific workspace
#[tauri::command]
pub fn invalidate_file_cache(workspace_path: String) -> Result<String, String> {
    println!("[COMMAND] invalidate_file_cache: {}", workspace_path);
    FILE_SCANNER.invalidate_cache(&workspace_path);
    Ok("Cache invalidated".to_string())
}

/// Clear entire file cache
#[tauri::command]
pub fn clear_file_cache() -> Result<String, String> {
    println!("[COMMAND] clear_file_cache");
    FILE_SCANNER.clear_cache();
    Ok("Cache cleared".to_string())
}

