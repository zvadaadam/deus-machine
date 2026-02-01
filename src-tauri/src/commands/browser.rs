use tauri::State;
use crate::browser::BrowserManager;
use std::path::PathBuf;

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
