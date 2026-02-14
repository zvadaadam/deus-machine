use crate::auth::{AuthError, AuthManager, AuthState};
use tauri::State;

/// Check if user is authenticated (reads from Keychain on first call).
/// `get_status()` handles lazy Keychain loading internally via `load_if_needed()`.
#[tauri::command]
pub fn auth_check_status(auth_manager: State<'_, AuthManager>) -> Result<AuthState, AuthError> {
    Ok(auth_manager.get_status())
}

/// Open system browser to Hivenet login page.
/// Provider selection (Google/GitHub) happens on the web page.
/// Login completion arrives asynchronously via deep link.
///
/// Generates a random state parameter (per RFC 8252) and appends it to the
/// auth URL. The deep link handler verifies this on callback to prevent
/// OAuth CSRF attacks.
#[tauri::command]
pub async fn auth_start_login(
    app: tauri::AppHandle,
    auth_manager: State<'_, AuthManager>,
) -> Result<(), AuthError> {
    let state = auth_manager.start_login();
    let url = format!("https://hivenet.app/auth/desktop?state={}", state);

    if let Err(e) = tauri_plugin_shell::ShellExt::shell(&app).open(&url, None) {
        // Prevent stale pending state if browser launch fails immediately.
        auth_manager.clear_login_pending();
        return Err(AuthError::Browser(e.to_string()));
    }

    println!("[AUTH] Opened browser for login");
    Ok(())
}

/// Clear stored identity and log out.
#[tauri::command]
pub fn auth_logout(auth_manager: State<'_, AuthManager>) -> Result<(), AuthError> {
    auth_manager.clear_keychain()
}
