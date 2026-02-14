// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use conductor_lib::{
    auth::AuthManager, backend::BackendManager, browser::BrowserManager, commands, pty::PtyManager,
    sidecar::SidecarManager, socket::SocketManager,
};
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

struct LoginPendingGuard<'a> {
    auth_manager: &'a AuthManager,
}

impl Drop for LoginPendingGuard<'_> {
    fn drop(&mut self) {
        self.auth_manager.clear_login_pending();
    }
}

fn emit_auth_error(app_handle: &tauri::AppHandle, message: impl Into<String>) {
    let message = message.into();
    eprintln!("[AUTH] {}", message);
    let _ = app_handle.emit("auth:login-error", message);
}

fn handle_auth_deep_link_url(
    url_string: &str,
    auth_manager: &AuthManager,
    app_handle: &tauri::AppHandle,
) {
    println!("[AUTH] Deep link received");

    // Only process expected OAuth callback URLs.
    let Ok(url) = url::Url::parse(url_string) else {
        return;
    };
    if url.scheme() != "hivenet" || url.host_str() != Some("auth") {
        return;
    }

    // Ignore unsolicited callbacks unless we explicitly initiated login.
    if !auth_manager.is_login_pending() {
        return;
    }

    if url.path() != "/callback" {
        emit_auth_error(
            app_handle,
            format!("Rejected callback: unexpected path '{}'", url.path()),
        );
        return;
    }

    let params: std::collections::HashMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    let received_state = params.get("state").map(String::as_str);
    if !auth_manager.verify_callback(received_state) {
        emit_auth_error(app_handle, "Rejected callback: state mismatch");
        return;
    }

    // Only clear login-pending after successful state verification.
    let _pending_guard = LoginPendingGuard { auth_manager };

    let provider = params.get("provider").map(String::as_str).unwrap_or("");
    let email = params.get("email").map(String::as_str).unwrap_or("");
    let name = params.get("name").map(String::as_str).unwrap_or("");
    let avatar = params.get("avatar").map(String::as_str).unwrap_or("");

    if provider.is_empty() || email.is_empty() {
        emit_auth_error(
            app_handle,
            "Deep link missing required params (provider, email)",
        );
        return;
    }

    match auth_manager.save_to_keychain(provider, email, name, avatar) {
        Ok(_) => {
            println!("[AUTH] Login complete via deep link");
            let _ = app_handle.emit("auth:login-complete", ());
        }
        Err(e) => {
            auth_manager.clear_keychain().ok();
            emit_auth_error(app_handle, format!("Failed to save login state: {}", e));
        }
    }
}

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
        .manage(AuthManager::new())
        .manage(BackendManager::new())
        .manage(BrowserManager::new())
        .manage(PtyManager::new())
        .manage(SidecarManager::new())
        .manage(SocketManager::new())
        .setup(|app| {
            // Auth identity is loaded lazily from Keychain on first
            // auth_check_status call — avoids triggering macOS Keychain
            // password prompt on startup for first-time users.

            // Process auth deep links on app startup and while app is running.
            let auth_for_deeplink = app.state::<AuthManager>().inner().clone();
            let app_handle_for_deeplink = app.handle().clone();
            match app.deep_link().get_current() {
                Ok(Some(urls)) => {
                    for url in urls {
                        let url_string = url.to_string();
                        handle_auth_deep_link_url(
                            &url_string,
                            &auth_for_deeplink,
                            &app_handle_for_deeplink,
                        );
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("[AUTH] Failed to check current deep link: {}", e);
                }
            }

            let auth_for_runtime_deeplink = auth_for_deeplink.clone();
            let app_handle_for_runtime_deeplink = app_handle_for_deeplink.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let url_string = url.to_string();
                    handle_auth_deep_link_url(
                        &url_string,
                        &auth_for_runtime_deeplink,
                        &app_handle_for_runtime_deeplink,
                    );
                }
            });

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
                let exe = std::env::current_exe()
                    .map_err(|e| format!("Failed to get current exe: {}", e))?;
                let exe_dir = exe.ancestors()
                    .nth(4)
                    .ok_or_else(|| "Executable path does not have enough parent directories".to_string())?
                    .to_path_buf();
                exe_dir.join("backend/server.cjs")
            } else {
                // Production mode
                app.path()
                    .resource_dir()
                    .map_err(|e| format!("Failed to get resource dir: {}", e))?
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
                let exe = std::env::current_exe()
                    .map_err(|e| format!("Failed to get current exe: {}", e))?;
                exe.ancestors()
                    .nth(4)
                    .ok_or_else(|| "Executable path does not have enough parent directories".to_string())?
                    .to_path_buf()
            } else {
                app.path()
                    .resource_dir()
                    .map_err(|e| format!("Failed to get resource dir: {}", e))?
            };

            // Sidecar path: resources/bin/index.bundled.cjs
            // In dev: relative to working directory
            // In prod: relative to resource_dir (Contents/Resources/)
            let sidecar_path = if cfg!(dev) {
                exe_dir.join("src-tauri/resources/bin/index.bundled.cjs")
            } else {
                exe_dir.join("bin/index.bundled.cjs")
            };

            // Database path (production OpenDevs app database)
            let home_dir = std::env::var("HOME")
                .ok()
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| {
                    // Fallback: use /tmp as a safe default that always exists
                    eprintln!("[TAURI] WARNING: HOME environment variable not set, using /tmp fallback");
                    "/tmp".to_string()
                });

            let db_path = format!(
                "{}/Library/Application Support/com.conductor.app/conductor.db",
                home_dir
            );

            println!("[TAURI] Starting sidecar from: {}", sidecar_path.display());
            println!("[TAURI] Using database at: {}", db_path);

            match sidecar_manager.start(sidecar_path, &db_path) {
                Ok(_) => {
                    if let Some(socket_path) = sidecar_manager.get_socket_path() {
                        println!("[TAURI] ✅ Sidecar started, socket: {}", socket_path);

                        // Retry connection with backoff — sidecar may not be accepting connections yet
                        let mut connected = false;
                        for attempt in 1..=5 {
                            match socket_manager.connect(socket_path.clone()) {
                                Ok(_) => {
                                    println!("[TAURI] ✅ Socket connected to sidecar (attempt {})", attempt);
                                    connected = true;
                                    break;
                                }
                                Err(e) => {
                                    if attempt < 5 {
                                        println!("[TAURI] Socket connect attempt {} failed: {}, retrying...", attempt, e);
                                        std::thread::sleep(std::time::Duration::from_millis(200 * attempt as u64));
                                    } else {
                                        eprintln!("[TAURI] Failed to connect socket after {} attempts: {}", attempt, e);
                                    }
                                }
                            }
                        }
                        if !connected {
                            eprintln!("[TAURI] ⚠️ Could not connect to sidecar socket — agent features may not work");
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
                if window.label() == "main" {
                    // Close detached browser window if open
                    if let Some(detached) = window.app_handle().get_window("browser-detached") {
                        detached.close().ok();
                    }

                    // Stop backend, sidecar, and browser when main window closes
                    let backend_manager: tauri::State<BackendManager> = window.state();
                    backend_manager.stop().ok();

                    let sidecar_manager: tauri::State<SidecarManager> = window.state();
                    sidecar_manager.stop().ok();

                    let browser_manager: tauri::State<BrowserManager> = window.state();
                    browser_manager.stop().ok();
                }
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
            commands::git_list_branches,
            commands::create_browser_webview,
            commands::navigate_browser_webview,
            commands::set_browser_webview_bounds,
            commands::show_browser_webview,
            commands::hide_browser_webview,
            commands::close_browser_webview,
            commands::get_browser_webview_url,
            commands::eval_browser_webview,
            commands::eval_browser_webview_with_result,
            commands::reload_browser_webview,
            commands::drain_browser_console,
            commands::get_cookie_browsers,
            commands::sync_browser_cookies,
            commands::inject_browser_cookies,
            commands::screenshot_browser_webview,
            commands::auth_check_status,
            commands::auth_start_login,
            commands::auth_logout,
            commands::check_cli_tool,
            commands::check_gh_auth,
            commands::enter_onboarding_mode,
            commands::exit_onboarding_mode,
            commands::show_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
