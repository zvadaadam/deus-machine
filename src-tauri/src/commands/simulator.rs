use std::process::Command;

use parking_lot::Mutex;
use tauri::{Emitter, State};

use opendevs_sim_core::app_manager;
use opendevs_sim_core::input::{map_button_type, map_direction, map_touch_phase};
use opendevs_sim_core::manager::{ensure_booted, parse_simctl_json, SimulatorState};
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
    udid: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<StreamInfo, String> {
    // Stop any existing session first — extract under lock, cleanup outside lock
    let (prev_server, prev_capture) = {
        let mut sim_state = state.lock();
        // Keep booted_udid for logging; we no longer shut down the previous sim.
        sim_state.booted_udid.take();
        (sim_state.server.take(), sim_state.capture.take())
    };
    if let Some(mut server) = prev_server {
        server.stop();
    }
    drop(prev_capture);
    // Intentionally NOT shutting down the previous simulator process here.
    // When switching from sim A to sim B, we only tear down the capture/MJPEG
    // pipeline — the sim itself stays "Booted". This lets auto-reconnect
    // re-attach nearly instantly when the user switches back (no cold boot).
    // Xcode itself follows the same pattern: sims stay booted across sessions.
    // Explicit shutdown only happens via stop_streaming (user clicks "Stop").

    // Boot the simulator headlessly if not already running
    ensure_booted(&udid).await.map_err(|e| e.to_string())?;

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
    println!("[TAURI] Simulator streaming started: {} (port {}, hid={})", info.url, info.port, hid_available);

    // Store in managed state
    let mut sim_state = state.lock();
    sim_state.capture = Some(capture);
    sim_state.server = Some(server);
    sim_state.booted_udid = Some(udid);

    Ok(info)
}

#[tauri::command]
pub async fn stop_streaming(state: State<'_, Mutex<SimulatorState>>) -> Result<(), String> {
    // Extract resources from state under the lock, then release the lock
    // BEFORE performing heavy cleanup (ObjC bridge destroy, simctl shutdown).
    let (server, capture, udid) = {
        let mut sim_state = state.lock();
        (
            sim_state.server.take(),
            sim_state.capture.take(),
            sim_state.booted_udid.take(),
        )
    };

    // Heavy cleanup on blocking thread pool — ObjC bridge destroy drains
    // dispatch queues, and simctl shutdown can take seconds.
    tokio::task::spawn_blocking(move || {
        // Stop MJPEG server first (signals shutdown, closes listener)
        if let Some(mut server) = server {
            server.stop();
        }

        // Drop ScreenCapture — triggers sim_bridge_destroy which drains dispatch queues.
        drop(capture);

        // Shut down the simulator (blocking command, can take seconds)
        if let Some(ref udid) = udid {
            println!("[TAURI] Shutting down simulator {}", udid);
            let _ = Command::new("xcrun")
                .args(["simctl", "shutdown", udid])
                .output();
        }

        println!("[TAURI] Simulator streaming stopped");
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn sim_send_touch(
    x: f64,
    y: f64,
    touch_type: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let Some(phase) = map_touch_phase(&touch_type) else {
        return Err(format!("Unknown touch type: {}", touch_type));
    };
    let mut sim_state = state.lock();

    if let Some(ref mut capture) = sim_state.capture {
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
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let sim_state = state.lock();

    if let Some(ref capture) = sim_state.capture {
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
    keycode: u16,
    direction: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let Some(dir) = map_direction(&direction) else {
        return Err(format!("Unknown key direction: {}", direction));
    };
    let sim_state = state.lock();

    if let Some(ref capture) = sim_state.capture {
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
    button_type: String,
    direction: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let Some(btn) = map_button_type(&button_type) else {
        return Err(format!("Unknown button type: {}", button_type));
    };
    let Some(dir) = map_direction(&direction) else {
        return Err(format!("Unknown button direction: {}", direction));
    };
    let sim_state = state.lock();

    if let Some(ref capture) = sim_state.capture {
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
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<Vec<u8>, String> {
    let sim_state = state.lock();

    if let Some(ref capture) = sim_state.capture {
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
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let sim_state = state.lock();

    if let Some(ref capture) = sim_state.capture {
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
    app_path: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<InstalledApp, String> {
    let udid = {
        let sim_state = state.lock();
        sim_state.booted_udid.clone()
    };

    let udid = udid.ok_or_else(|| "No simulator is currently booted".to_string())?;

    let installed = app_manager::install_app(&udid, &app_path)
        .await
        .map_err(|e| e.to_string())?;

    println!("[TAURI] Installed app: {} ({})", installed.name, installed.bundle_id);

    // Store in state
    let mut sim_state = state.lock();
    sim_state.installed_app = Some(installed.clone());

    Ok(installed)
}

#[tauri::command]
pub async fn sim_launch_app(
    bundle_id: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let udid = {
        let sim_state = state.lock();
        sim_state.booted_udid.clone()
    };

    let udid = udid.ok_or_else(|| "No simulator is currently booted".to_string())?;

    app_manager::launch_app(&udid, &bundle_id)
        .await
        .map_err(|e| e.to_string())?;

    println!("[TAURI] Launched app: {}", bundle_id);
    Ok(())
}

#[tauri::command]
pub async fn sim_terminate_app(
    bundle_id: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let udid = {
        let sim_state = state.lock();
        sim_state.booted_udid.clone()
    };

    let udid = udid.ok_or_else(|| "No simulator is currently booted".to_string())?;

    app_manager::terminate_app(&udid, &bundle_id)
        .await
        .map_err(|e| e.to_string())?;

    println!("[TAURI] Terminated app: {}", bundle_id);
    Ok(())
}

#[tauri::command]
pub async fn sim_uninstall_app(
    bundle_id: String,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<(), String> {
    let udid = {
        let sim_state = state.lock();
        sim_state.booted_udid.clone()
    };

    let udid = udid.ok_or_else(|| "No simulator is currently booted".to_string())?;

    app_manager::uninstall_app(&udid, &bundle_id)
        .await
        .map_err(|e| e.to_string())?;

    // Clear installed app if it matches
    let mut sim_state = state.lock();
    if sim_state.installed_app.as_ref().is_some_and(|a| a.bundle_id == bundle_id) {
        sim_state.installed_app = None;
    }

    println!("[TAURI] Uninstalled app: {}", bundle_id);
    Ok(())
}

/// One-shot: detect Xcode project in workspace, build, install, and launch.
/// Streams build log output via Tauri events ("sim:build-log").
#[tauri::command]
pub async fn sim_build_and_run(
    workspace_path: String,
    app_handle: tauri::AppHandle,
    state: State<'_, Mutex<SimulatorState>>,
) -> Result<InstalledApp, String> {
    let udid = {
        let sim_state = state.lock();
        sim_state.booted_udid.clone()
    };

    let udid = udid.ok_or_else(|| "No simulator is currently booted".to_string())?;

    println!("[TAURI] Building & running from: {}", workspace_path);

    // Stream build log lines to the frontend via Tauri events
    let on_log: Option<opendevs_sim_core::app_manager::BuildLogCallback> = Some(
        std::sync::Arc::new(move |line: &str| {
            let _ = app_handle.emit("sim:build-log", line.to_string());
        }),
    );

    let installed = app_manager::build_and_run(&workspace_path, &udid, on_log)
        .await
        .map_err(|e| e.to_string())?;

    println!("[TAURI] Built & running: {} ({})", installed.name, installed.bundle_id);

    // Store in state
    let mut sim_state = state.lock();
    sim_state.installed_app = Some(installed.clone());

    Ok(installed)
}

/// Fast probe: check if a workspace contains a buildable Xcode project.
/// Pure filesystem scan — no subprocess, no xcodebuild, no state mutation.
/// Async to avoid blocking the main thread during workspace switches.
#[tauri::command]
pub async fn sim_has_xcode_project(workspace_path: String) -> bool {
    tokio::task::spawn_blocking(move || app_manager::has_xcode_project(&workspace_path))
        .await
        .unwrap_or(false)
}
