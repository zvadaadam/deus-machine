// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(unexpected_cfgs)]

use tauri::Manager;
use opendevs_lib::{
    commands,
    backend::BackendManager,
    browser::BrowserManager,
    db::DbManager,
    pty::PtyManager,
    sidecar::SidecarManager,
    socket::SocketManager,
    watcher::WatcherManager,
};
#[cfg(target_os = "macos")]
use opendevs_sim_core::manager::SimulatorSessions;

fn main() {
    // Initialize Sentry for panic capture and error monitoring.
    // DSN read from SENTRY_DSN_RUST env var at compile time (not hardcoded — open source repo).
    // Guard must live for the entire app lifetime — dropping it flushes pending events.
    let _sentry_guard = sentry::init((
        option_env!("SENTRY_DSN_RUST").unwrap_or(""),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            // cfg!(dev) is set only by `tauri dev`, not by `tauri build --debug`
            environment: Some(
                if cfg!(dev) { "development" } else { "production" }.into(),
            ),
            send_default_pii: true,
            ..Default::default()
        },
    ));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        // Persist window size/position/maximize/fullscreen across sessions.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(BackendManager::new())
        .manage(BrowserManager::new())
        .manage(DbManager::new())
        .manage(PtyManager::new())
        .manage(SidecarManager::new())
        .manage(SocketManager::new())
        .manage(WatcherManager::new());

    #[cfg(target_os = "macos")]
    let builder = builder.manage(parking_lot::Mutex::new(SimulatorSessions {
        sessions: std::collections::HashMap::new(),
    }));

    builder
        .setup(|app| {
            let setup_start = std::time::Instant::now();

            // Set app handle for PTY manager so it can emit events
            let pty_manager: tauri::State<PtyManager> = app.state();
            pty_manager.set_app_handle(app.handle().clone());

            // Set app handle for Socket manager so it can emit events
            let socket_manager: tauri::State<SocketManager> = app.state();
            socket_manager.set_app_handle(app.handle().clone());
            socket_manager.start_event_listener();
            println!("[TAURI] ✅ Socket event listener started");

            // Set app handle for Watcher manager so it can emit fs:changed events
            let watcher_manager: tauri::State<WatcherManager> = app.state();
            watcher_manager.set_app_handle(app.handle().clone());
            watcher_manager.start_debounce_thread();
            println!("[TAURI] ✅ File watcher manager initialized");

            // Compute database path early — both backend and sidecar need it
            let db_dir = app.path().app_data_dir()
                .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
            std::fs::create_dir_all(&db_dir)
                .map_err(|e| format!("Failed to create app data dir {}: {e}", db_dir.display()))?;
            let db_path = db_dir.join("opendevs.db");
            let db_path = db_path.to_string_lossy().to_string();

            println!("[TAURI] Using database at: {}", db_path);

            // Open database for direct Rust reads (hot-path queries)
            let db_manager: tauri::State<DbManager> = app.state();
            match db_manager.open(&db_path) {
                Ok(_) => println!("[TAURI] ✅ Database opened for direct reads"),
                Err(e) => eprintln!("[TAURI] ⚠️ Failed to open database for direct reads: {} — will fall back to HTTP", e),
            }

            // Set app handle for Backend manager so it can relay workspace progress events
            let backend_manager: tauri::State<BackendManager> = app.state();
            backend_manager.set_app_handle(app.handle().clone());

            // Compute the base directory for bundled resources.
            // Dev: project root (4 levels up from the Tauri executable).
            // Prod: Contents/Resources/ inside the app bundle.
            let resource_base = if cfg!(dev) {
                let exe = std::env::current_exe()
                    .map_err(|e| format!("Failed to get current exe: {e}"))?;
                exe.ancestors()
                    .nth(4)
                    .ok_or_else(|| "Executable path does not have enough parent directories".to_string())?
                    .to_path_buf()
            } else {
                app.path()
                    .resource_dir()
                    .map_err(|e| format!("Failed to get resource dir: {e}"))?
            };

            let backend_path = resource_base.join("backend/server.cjs");
            println!("[TAURI] Starting backend from: {}", backend_path.display());

            match backend_manager.start(backend_path.clone(), &db_path) {
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

            let sidecar_path = if cfg!(dev) {
                resource_base.join("src-tauri/resources/bin/index.bundled.cjs")
            } else {
                resource_base.join("bin/index.bundled.cjs")
            };

            println!("[TAURI] Starting sidecar from: {}", sidecar_path.display());

            let notify_url = backend_manager.get_port()
                .map(|port| format!("http://localhost:{}/api/notify", port));

            match sidecar_manager.start(sidecar_path, &db_path, notify_url.as_deref()) {
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

            println!("[TAURI] ✅ Setup complete in {}ms", setup_start.elapsed().as_millis());
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

                    let watcher_manager: tauri::State<WatcherManager> = window.state();
                    watcher_manager.unwatch_all();

                    // Stop all simulator streaming sessions and shut down simulators
                    #[cfg(target_os = "macos")]
                    {
                        let sim_sessions: tauri::State<parking_lot::Mutex<SimulatorSessions>> = window.state();
                        let drained: Vec<_> = {
                            let mut s = sim_sessions.lock();
                            s.sessions.drain().collect()
                        };
                        for (_workspace_id, mut session) in drained {
                            if let Some(mut server) = session.server.take() {
                                server.stop();
                            }
                            drop(session.capture.take());
                            let udid = session.udid;
                            std::thread::spawn(move || {
                                let _ = std::process::Command::new("xcrun")
                                    .args(["simctl", "shutdown", &udid])
                                    .output();
                            });
                        }
                    }
                }
            }
        })
        .invoke_handler({
            // Macro to list all shared commands once. macOS adds simulator commands;
            // non-macOS uses just the common set.
            macro_rules! common_handlers {
                ($($extra:ident),* $(,)?) => {
                    tauri::generate_handler![
                        commands::spawn_pty,
                        commands::resize_pty,
                        commands::write_to_pty,
                        commands::kill_pty,
                        commands::connect_to_sidecar,
                        commands::send_sidecar_message,
                        commands::receive_sidecar_message,
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
                        commands::fuzzy_file_search,
                        commands::invalidate_file_cache,
                        commands::clear_file_cache,
                        commands::git_clone,
                        commands::git_diff_stats,
                        commands::git_diff_files,
                        commands::git_diff_file,
                        commands::git_uncommitted_files,
                        commands::git_last_turn_files,
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
                        commands::open_browser_devtools,
                        commands::close_browser_devtools,
                        commands::drain_browser_console,
                        commands::get_cookie_browsers,
                        commands::sync_browser_cookies,
                        commands::inject_browser_cookies,
                        commands::screenshot_browser_webview,
                        commands::check_cli_tool,
                        commands::check_gh_auth,
                        commands::enter_onboarding_mode,
                        commands::exit_onboarding_mode,
                        commands::show_main_window,
                        commands::db_get_workspaces_by_repo,
                        commands::db_get_stats,
                        commands::db_get_session,
                        commands::db_get_messages,
                        commands::watch_workspace,
                        commands::unwatch_workspace,
                        $(commands::$extra),*
                    ]
                };
            }

            #[cfg(target_os = "macos")]
            {
                common_handlers![
                    list_simulators,
                    start_streaming,
                    stop_streaming,
                    get_stream_info,
                    sim_send_touch,
                    sim_send_scroll,
                    sim_send_key,
                    sim_send_button,
                    sim_take_screenshot,
                    sim_press_home,
                    sim_install_app,
                    sim_launch_app,
                    sim_terminate_app,
                    sim_uninstall_app,
                    sim_build_and_run,
                    sim_has_xcode_project,
                ]
            }
            #[cfg(not(target_os = "macos"))]
            { common_handlers![] }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
