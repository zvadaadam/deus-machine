// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use conductor_lib::{
    commands,
    backend::BackendManager,
    browser::BrowserManager,
    pty::PtyManager,
    sidecar::SidecarManager,
    socket::SocketManager,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(BackendManager::new())
        .manage(BrowserManager::new())
        .manage(PtyManager::new())
        .manage(SidecarManager::new())
        .manage(SocketManager::new())
        .setup(|app| {
            // Set app handle for PTY manager so it can emit events
            let pty_manager: tauri::State<PtyManager> = app.state();
            pty_manager.set_app_handle(app.handle().clone());

            // Set app handle for Socket manager so it can emit events
            let socket_manager: tauri::State<SocketManager> = app.state();
            socket_manager.set_app_handle(app.handle().clone());
            socket_manager.start_event_listener();
            println!("[TAURI] ✅ Socket event listener started");

            // Start backend server
            let backend_manager: tauri::State<BackendManager> = app.state();

            // Determine backend path
            // In dev: Get the workspace root (project directory)
            // In prod: resources/backend/server.cjs (bundled in app)
            let backend_path = if cfg!(dev) {
                // Development mode - resolve relative to the executable
                let exe_dir = std::env::current_exe()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .to_path_buf();
                exe_dir.join("backend/server.cjs")
            } else {
                // Production mode
                app.path()
                    .resource_dir()
                    .unwrap()
                    .join("backend/server.cjs")
            };

            println!("[TAURI] Starting backend from: {}", backend_path.display());

            match backend_manager.start(backend_path.clone()) {
                Ok(_) => {
                    if let Some(port) = backend_manager.get_port() {
                        println!("[TAURI] Backend started successfully on port {}", port);
                    } else {
                        println!("[TAURI] Backend started (port detection pending)");
                    }
                },
                Err(e) => {
                    eprintln!("[TAURI] Failed to start backend: {}", e);
                    eprintln!("[TAURI] App will continue but backend features will not work");
                }
            }

            // Start sidecar-v2 (agent runtime)
            let sidecar_manager: tauri::State<SidecarManager> = app.state();

            // Determine sidecar path and database path
            let exe_dir = if cfg!(dev) {
                std::env::current_exe()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .to_path_buf()
            } else {
                app.path()
                    .resource_dir()
                    .unwrap()
            };

            // Sidecar path: resources/bin/index.bundled.cjs
            // In dev: relative to working directory
            // In prod: relative to resource_dir (Contents/Resources/)
            let sidecar_path = if cfg!(dev) {
                exe_dir.join("src-tauri/resources/bin/index.bundled.cjs")
            } else {
                exe_dir.join("bin/index.bundled.cjs")
            };

            // Database path (production Conductor app database)
            let db_path = format!(
                "{}/Library/Application Support/com.conductor.app/conductor.db",
                std::env::var("HOME").unwrap_or_default()
            );

            println!("[TAURI] Starting sidecar from: {}", sidecar_path.display());
            println!("[TAURI] Using database at: {}", db_path);

            match sidecar_manager.start(sidecar_path, &db_path) {
                Ok(_) => {
                    if let Some(socket_path) = sidecar_manager.get_socket_path() {
                        println!("[TAURI] ✅ Sidecar started, socket: {}", socket_path);

                        // Auto-connect the socket manager to sidecar
                        match socket_manager.connect(socket_path.clone()) {
                            Ok(_) => {
                                println!("[TAURI] ✅ Socket connected to sidecar");
                            }
                            Err(e) => {
                                eprintln!("[TAURI] Failed to connect socket: {}", e);
                            }
                        }
                    } else {
                        println!("[TAURI] Sidecar started (socket path detection pending)");
                    }
                },
                Err(e) => {
                    eprintln!("[TAURI] Failed to start sidecar: {}", e);
                    eprintln!("[TAURI] App will continue but agent features will not work");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Stop backend, sidecar, and browser when window closes
                let backend_manager: tauri::State<BackendManager> = window.state();
                backend_manager.stop().ok();

                let sidecar_manager: tauri::State<SidecarManager> = window.state();
                sidecar_manager.stop().ok();

                let browser_manager: tauri::State<BrowserManager> = window.state();
                browser_manager.stop().ok();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_pty,
            commands::resize_pty,
            commands::write_to_pty,
            commands::kill_pty,
            commands::connect_to_sidecar,
            commands::send_sidecar_message,
            commands::receive_sidecar_message,
            commands::disconnect_from_sidecar,
            commands::is_sidecar_connected,
            commands::get_sidecar_socket_path,
            commands::get_backend_port,
            commands::get_installed_apps,
            commands::open_in_app,
            commands::start_browser_server,
            commands::stop_browser_server,
            commands::get_browser_port,
            commands::get_browser_auth_token,
            commands::is_browser_running,
            commands::read_text_file,
            commands::scan_workspace_files,
            commands::invalidate_file_cache,
            commands::clear_file_cache,
            commands::git_clone,
            commands::git_diff_stats,
            commands::git_diff_files,
            commands::git_diff_file,
            commands::git_detect_default_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
