use tauri::State;
use crate::browser::BrowserManager;
use std::path::PathBuf;

/// Start the dev-browser HTTP server
#[tauri::command]
pub fn start_browser_server(
    browser_path: String,
    browser_manager: State<'_, BrowserManager>,
) -> Result<String, String> {
    let path = PathBuf::from(&browser_path);

    // Verify path exists
    if !path.exists() {
        return Err(format!(
            "Browser path does not exist: {}. Set VITE_DEV_BROWSER_PATH to an absolute path.",
            browser_path
        ));
    }

    browser_manager
        .start(path)
        .map_err(|e| {
            format!("Failed to start browser server: {}", e)
        })?;

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
