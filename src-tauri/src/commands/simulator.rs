use std::process::Command;

use parking_lot::Mutex;
use tauri::{Emitter, State};

use opendevs_sim_core::app_manager;
use opendevs_sim_core::input::{map_button_type, map_direction, map_touch_phase};
use opendevs_sim_core::manager::{ensure_booted, parse_simctl_json, SimSession, SimulatorSessions};
use opendevs_sim_core::mjpeg_server::MjpegServer;
use opendevs_sim_core::screen_capture::ScreenCapture;
use opendevs_sim_core::types::{InstalledApp, SimulatorInfo, StreamInfo};

#[tauri::command]
pub async fn list_simulators() -> Result<Vec<SimulatorInfo>, String> {
    // Run on blocking thread pool — xcrun simctl list takes 1-3s and would
    // freeze the macOS main thread (AppKit event loop) if run synchronously.
    tokio::task::spawn_blocking(|| {
        let output = Command::new("xcrun")
            .args(["simctl", "list", "devices", "--json"])
            .output()
            .map_err(|e| format!("Failed to run xcrun simctl: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("simctl failed: {}", stderr));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        parse_simctl_json(&json_str).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn start_streaming(
    workspace_id: String,
    udid: String,
    skip_boot_check: Option<bool>,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<StreamInfo, String> {
    // Only stop THIS workspace's previous session (other workspaces are untouched)
    let prev = {
        let mut sessions = state.lock();
        sessions.sessions.remove(&workspace_id)
    };
    if let Some(mut session) = prev {
        // Heavy cleanup on blocking thread pool — ObjC sim_bridge_destroy in
        // ScreenCapture's Drop drains dispatch queues and must not run inline
        // on the async command path. Consistent with stop_streaming's pattern.
        tokio::task::spawn_blocking(move || {
            if let Some(mut server) = session.server.take() {
                server.stop();
            }
            drop(session.capture.take());
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    }

    // Boot the simulator headlessly if not already running.
    // Frontend can skip this when it already knows the device is booted
    // (saves 1-10s of `simctl list --json` parsing).
    if !skip_boot_check.unwrap_or(false) {
        ensure_booted(&udid).await.map_err(|e| e.to_string())?;
    }

    // Create new screen capture (wraps blocking ObjC init with 500ms sleep)
    let capture_udid = udid.clone();
    let mut capture = tokio::task::spawn_blocking(move || ScreenCapture::new(&capture_udid))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
    capture.start()?;

    // Start MJPEG server with a watch receiver (never misses frames)
    let server = MjpegServer::start(capture.subscribe()).await?;

    let hid_available = capture.is_hid_available();
    let info = StreamInfo {
        url: server.url(),
        port: server.port(),
        hid_available,
    };

    if !hid_available {
        println!("[TAURI] WARNING: HID client not available — touch/scroll/key injection disabled");
    }
    println!(
        "[TAURI] Simulator streaming started for workspace {}: {} (port {}, hid={})",
        workspace_id, info.url, info.port, hid_available
    );

    // Store in per-workspace session. Check if a racing concurrent start_streaming
    // call inserted a session between our two lock acquisitions — if so, clean it up
    // to avoid leaking ObjC resources.
    let evicted = {
        let mut sessions = state.lock();
        sessions.sessions.insert(
            workspace_id,
            SimSession {
                udid,
                capture: Some(capture),
                server: Some(server),
                installed_app: None,
            },
        )
    };
    if let Some(mut evicted_session) = evicted {
        tokio::task::spawn_blocking(move || {
            if let Some(mut server) = evicted_session.server.take() {
                server.stop();
            }
            drop(evicted_session.capture.take());
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;
    }

    Ok(info)
}

#[tauri::command]
pub async fn stop_streaming(
    workspace_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let (session, udid_still_in_use) = {
        let mut sessions = state.lock();
        let removed = sessions.sessions.remove(&workspace_id);
        let still_in_use = if let Some(ref s) = removed {
            sessions.sessions.values().any(|other| other.udid == s.udid)
        } else {
            false
        };
        (removed, still_in_use)
    };

    let Some(mut session) = session else {
        println!("[TAURI] No active session for workspace {}", workspace_id);
        return Ok(());
    };

    let udid = session.udid.clone();

    // Heavy cleanup on blocking thread pool — ObjC bridge destroy drains
    // dispatch queues, and simctl shutdown can take seconds.
    tokio::task::spawn_blocking(move || {
        // Stop MJPEG server first (signals shutdown, closes listener)
        if let Some(mut server) = session.server.take() {
            server.stop();
        }

        // Drop ScreenCapture — triggers sim_bridge_destroy which drains dispatch queues.
        drop(session.capture.take());

        // Only shut down the simulator if no other workspace is still using this UDID
        if !udid_still_in_use {
            println!("[TAURI] Shutting down simulator {}", udid);
            let _ = Command::new("xcrun")
                .args(["simctl", "shutdown", &udid])
                .output();
        } else {
            println!(
                "[TAURI] Skipping simulator shutdown — UDID {} still in use by another workspace",
                udid
            );
        }

        println!(
            "[TAURI] Simulator streaming stopped for workspace {}",
            workspace_id
        );
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    Ok(())
}

/// Query the stream info for a workspace's active simulator session.
/// Returns None if the workspace has no active session.
#[tauri::command]
pub fn get_stream_info(
    workspace_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Option<StreamInfo> {
    let sessions = state.lock();
    sessions.sessions.get(&workspace_id).and_then(|session| {
        let server = session.server.as_ref()?;
        let capture = session.capture.as_ref()?;
        Some(StreamInfo {
            url: server.url(),
            port: server.port(),
            hid_available: capture.is_hid_available(),
        })
    })
}

#[tauri::command]
pub fn sim_send_touch(
    workspace_id: String,
    x: f64,
    y: f64,
    touch_type: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let Some(phase) = map_touch_phase(&touch_type) else {
        return Err(format!("Unknown touch type: {}", touch_type));
    };
    let mut sessions = state.lock();
    let session = sessions
        .sessions
        .get_mut(&workspace_id)
        .ok_or_else(|| format!("No active session for workspace {}", workspace_id))?;

    if let Some(ref mut capture) = session.capture {
        if !capture.send_touch(x, y, phase) {
            return Err("Touch injection failed — HID client may not be available".to_string());
        }
    } else {
        return Err("No active capture for touch event".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn sim_send_scroll(
    workspace_id: String,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let sessions = state.lock();
    let session = sessions
        .sessions
        .get(&workspace_id)
        .ok_or_else(|| format!("No active session for workspace {}", workspace_id))?;

    if let Some(ref capture) = session.capture {
        if !capture.send_scroll(x, y, dx, dy) {
            return Err("Scroll injection failed — HID client may not be available".to_string());
        }
    } else {
        return Err("No active capture for scroll event".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn sim_send_key(
    workspace_id: String,
    keycode: u16,
    direction: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let Some(dir) = map_direction(&direction) else {
        return Err(format!("Unknown key direction: {}", direction));
    };
    let sessions = state.lock();
    let session = sessions
        .sessions
        .get(&workspace_id)
        .ok_or_else(|| format!("No active session for workspace {}", workspace_id))?;

    if let Some(ref capture) = session.capture {
        if !capture.send_key(keycode, dir) {
            return Err(format!("Key injection failed for keycode 0x{:04x}", keycode));
        }
    } else {
        return Err("No active capture for key event".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn sim_send_button(
    workspace_id: String,
    button_type: String,
    direction: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let Some(btn) = map_button_type(&button_type) else {
        return Err(format!("Unknown button type: {}", button_type));
    };
    let Some(dir) = map_direction(&direction) else {
        return Err(format!("Unknown button direction: {}", direction));
    };
    let sessions = state.lock();
    let session = sessions
        .sessions
        .get(&workspace_id)
        .ok_or_else(|| format!("No active session for workspace {}", workspace_id))?;

    if let Some(ref capture) = session.capture {
        if !capture.send_button(btn, dir) {
            return Err(format!("Button injection failed for type {}", button_type));
        }
    } else {
        return Err("No active capture for button event".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn sim_take_screenshot(
    workspace_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<Vec<u8>, String> {
    let sessions = state.lock();
    let session = sessions
        .sessions
        .get(&workspace_id)
        .ok_or_else(|| format!("No active session for workspace {}", workspace_id))?;

    if let Some(ref capture) = session.capture {
        if let Some(data) = capture.screenshot() {
            println!("[TAURI] Screenshot captured: {} bytes", data.len());
            Ok(data)
        } else {
            Err("Failed to capture screenshot".to_string())
        }
    } else {
        Err("No active capture for screenshot".to_string())
    }
}

#[tauri::command]
pub fn sim_press_home(
    workspace_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let sessions = state.lock();
    let session = sessions
        .sessions
        .get(&workspace_id)
        .ok_or_else(|| format!("No active session for workspace {}", workspace_id))?;

    if let Some(ref capture) = session.capture {
        if !capture.press_home() {
            return Err("Failed to press Home button".to_string());
        }
    } else {
        return Err("No active capture for Home button".to_string());
    }

    Ok(())
}

// --- App Management Commands ---

#[tauri::command]
pub async fn sim_install_app(
    workspace_id: String,
    app_path: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<InstalledApp, String> {
    let udid = {
        let sessions = state.lock();
        sessions.sessions.get(&workspace_id).map(|s| s.udid.clone())
    };
    let udid = udid.ok_or_else(|| {
        format!(
            "No active session for workspace {} — start streaming first",
            workspace_id
        )
    })?;

    let installed = app_manager::install_app(&udid, &app_path)
        .await
        .map_err(|e| e.to_string())?;

    println!(
        "[TAURI] Installed app: {} ({})",
        installed.name, installed.bundle_id
    );

    // Store in session state
    let mut sessions = state.lock();
    if let Some(session) = sessions.sessions.get_mut(&workspace_id) {
        session.installed_app = Some(installed.clone());
    }

    Ok(installed)
}

#[tauri::command]
pub async fn sim_launch_app(
    workspace_id: String,
    bundle_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let udid = {
        let sessions = state.lock();
        sessions.sessions.get(&workspace_id).map(|s| s.udid.clone())
    };
    let udid = udid.ok_or_else(|| {
        format!(
            "No active session for workspace {} — start streaming first",
            workspace_id
        )
    })?;

    app_manager::launch_app(&udid, &bundle_id)
        .await
        .map_err(|e| e.to_string())?;

    println!("[TAURI] Launched app: {}", bundle_id);
    Ok(())
}

#[tauri::command]
pub async fn sim_terminate_app(
    workspace_id: String,
    bundle_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let udid = {
        let sessions = state.lock();
        sessions.sessions.get(&workspace_id).map(|s| s.udid.clone())
    };
    let udid = udid.ok_or_else(|| {
        format!(
            "No active session for workspace {} — start streaming first",
            workspace_id
        )
    })?;

    app_manager::terminate_app(&udid, &bundle_id)
        .await
        .map_err(|e| e.to_string())?;

    println!("[TAURI] Terminated app: {}", bundle_id);
    Ok(())
}

#[tauri::command]
pub async fn sim_uninstall_app(
    workspace_id: String,
    bundle_id: String,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<(), String> {
    let udid = {
        let sessions = state.lock();
        sessions.sessions.get(&workspace_id).map(|s| s.udid.clone())
    };
    let udid = udid.ok_or_else(|| {
        format!(
            "No active session for workspace {} — start streaming first",
            workspace_id
        )
    })?;

    app_manager::uninstall_app(&udid, &bundle_id)
        .await
        .map_err(|e| e.to_string())?;

    // Clear installed app if it matches
    let mut sessions = state.lock();
    if let Some(session) = sessions.sessions.get_mut(&workspace_id) {
        if session
            .installed_app
            .as_ref()
            .is_some_and(|a| a.bundle_id == bundle_id)
        {
            session.installed_app = None;
        }
    }

    println!("[TAURI] Uninstalled app: {}", bundle_id);
    Ok(())
}

/// One-shot: detect Xcode project in workspace, build, install, and launch.
/// Streams build log output via Tauri events ("sim:build-log").
#[tauri::command]
pub async fn sim_build_and_run(
    workspace_id: String,
    workspace_path: String,
    app_handle: tauri::AppHandle,
    state: State<'_, Mutex<SimulatorSessions>>,
) -> Result<InstalledApp, String> {
    let udid = {
        let sessions = state.lock();
        sessions.sessions.get(&workspace_id).map(|s| s.udid.clone())
    };
    let udid = udid.ok_or_else(|| {
        format!(
            "No active session for workspace {} — start streaming first",
            workspace_id
        )
    })?;

    println!("[TAURI] Building & running from: {}", workspace_path);

    // Stream build log lines to the frontend via Tauri events.
    // Payload includes workspace_id so the frontend can filter per-workspace
    // when multiple workspaces are building concurrently.
    let ws_id = workspace_id.clone();
    let on_log: Option<opendevs_sim_core::app_manager::BuildLogCallback> = Some(
        std::sync::Arc::new(move |line: &str| {
            let _ = app_handle.emit(
                "sim:build-log",
                serde_json::json!({ "workspaceId": ws_id, "line": line }),
            );
        }),
    );

    let installed = app_manager::build_and_run(&workspace_path, &udid, on_log)
        .await
        .map_err(|e| e.to_string())?;

    println!(
        "[TAURI] Built & running: {} ({})",
        installed.name, installed.bundle_id
    );

    // Store in session state
    let mut sessions = state.lock();
    if let Some(session) = sessions.sessions.get_mut(&workspace_id) {
        session.installed_app = Some(installed.clone());
    }

    Ok(installed)
}

/// Fast probe: check if a workspace contains a buildable Xcode project.
/// Pure filesystem scan — no subprocess, no xcodebuild, no state mutation.
/// Async to avoid blocking the main thread during workspace switches.
#[tauri::command]
pub async fn sim_has_xcode_project(workspace_path: String) -> bool {
    tokio::task::spawn_blocking(move || app_manager::has_xcode_project(&workspace_path))
        .await
        .unwrap_or_else(|e| {
            eprintln!("[TAURI] sim_has_xcode_project join error: {}", e);
            false
        })
}
