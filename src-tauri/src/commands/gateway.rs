use tauri::State;
use crate::backend::BackendManager;
use crate::db::DbManager;
use crate::gateway::GatewayManager;
use crate::sidecar::SidecarManager;

/// Check if the messaging gateway is currently running
#[tauri::command]
pub fn is_gateway_running(
    gateway_manager: State<'_, GatewayManager>,
) -> Result<bool, String> {
    Ok(gateway_manager.is_running())
}

/// Stop the messaging gateway
#[tauri::command]
pub fn stop_gateway(
    gateway_manager: State<'_, GatewayManager>,
) -> Result<String, String> {
    gateway_manager.stop().map_err(|e| e.to_string())?;
    Ok("Gateway stopped".to_string())
}

/// Resolve the gateway entry point path based on dev/prod mode.
fn resolve_gateway_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe: {}", e))?;

    if cfg!(dev) {
        let exe_dir = exe.ancestors()
            .nth(4)
            .ok_or_else(|| "Executable path does not have enough parent directories".to_string())?
            .to_path_buf();
        Ok(exe_dir.join("gateway/index.ts"))
    } else {
        let exe_dir = exe.parent()
            .ok_or_else(|| "Executable has no parent directory".to_string())?;
        // In production, gateway.bundled.cjs is in Contents/Resources/bin/
        Ok(exe_dir.join("../Resources/bin/gateway.bundled.cjs"))
    }
}

/// Start the messaging gateway by reading tokens from preferences.json
/// and resolving backend URL + sidecar socket path from Rust state.
///
/// The frontend calls this with zero arguments — all config is resolved internally.
/// This is the primary way to start the gateway from the Settings UI toggle.
#[tauri::command]
pub fn start_gateway(
    db_manager: State<'_, DbManager>,
    backend_manager: State<'_, BackendManager>,
    sidecar_manager: State<'_, SidecarManager>,
    gateway_manager: State<'_, GatewayManager>,
) -> Result<String, String> {
    // Read tokens from preferences.json
    let telegram_token = db_manager.read_setting("telegram_bot_token")
        .unwrap_or(None)
        .filter(|s| !s.is_empty());

    let whatsapp_dir = db_manager.read_setting("whatsapp_session_dir")
        .unwrap_or(None)
        .filter(|s| !s.is_empty());

    if telegram_token.is_none() && whatsapp_dir.is_none() {
        return Err("No messaging channels configured. Add a Telegram bot token or WhatsApp session directory in Settings → Messaging.".to_string());
    }

    // Resolve internal paths from Rust state
    let backend_port = backend_manager.get_port()
        .ok_or("Backend is not running")?;
    let sidecar_socket = sidecar_manager.get_socket_path()
        .ok_or("Sidecar is not running")?;

    let gateway_path = resolve_gateway_path()?;
    let backend_url = format!("http://localhost:{}", backend_port);

    gateway_manager.start(
        gateway_path,
        &backend_url,
        &sidecar_socket,
        telegram_token.as_deref(),
        whatsapp_dir.as_deref(),
    ).map_err(|e| e.to_string())?;

    Ok("Gateway started".to_string())
}
