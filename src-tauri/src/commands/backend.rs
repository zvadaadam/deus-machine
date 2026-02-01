use tauri::State;
use crate::backend::BackendManager;

/// Get the dynamic port the backend is running on
#[tauri::command]
pub fn get_backend_port(
    backend_manager: State<'_, BackendManager>,
) -> Result<u16, String> {
    backend_manager
        .get_port()
        .ok_or_else(|| "Backend port not available yet".to_string())
}
