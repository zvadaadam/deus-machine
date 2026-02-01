use tauri::State;
use crate::socket::SocketManager;

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
