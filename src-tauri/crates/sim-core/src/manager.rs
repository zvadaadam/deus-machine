use std::process::Command;

use crate::error::SimulatorError;
use crate::mjpeg_server::MjpegServer;
use crate::screen_capture::ScreenCapture;
use crate::types::{InstalledApp, SimulatorInfo};

/// Managed state holding the active simulator session.
pub struct SimulatorState {
    pub capture: Option<ScreenCapture>,
    pub server: Option<MjpegServer>,
    pub booted_udid: Option<String>,
    pub installed_app: Option<InstalledApp>,
}

/// Boot a simulator if it's not already booted.
pub async fn ensure_booted(udid: &str) -> Result<(), SimulatorError> {
    // Check current state (blocking I/O wrapped in spawn_blocking)
    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "list", "devices", "--json"])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl list failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| SimulatorError::Simctl(format!("failed to parse: {}", e)))?;

    let already_booted = json["devices"]
        .as_object()
        .iter()
        .flat_map(|m| m.values())
        .filter_map(|v| v.as_array())
        .flatten()
        .any(|d| d["udid"].as_str() == Some(udid) && d["state"].as_str() == Some("Booted"));

    if already_booted {
        log::info!("Simulator {} is already booted", udid);
        return Ok(());
    }

    log::info!("Booting simulator {}...", udid);
    let udid_owned = udid.to_string();
    let boot_output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "boot", &udid_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("failed to boot: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !boot_output.status.success() {
        let stderr = String::from_utf8_lossy(&boot_output.stderr);
        // "already booted" is not an error
        if stderr.contains("current state: Booted") {
            return Ok(());
        }
        return Err(SimulatorError::BootFailed {
            udid: udid.to_string(),
            reason: stderr.trim().to_string(),
        });
    }

    // Wait for the simulator to fully initialize
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    log::info!("Simulator {} booted successfully", udid);
    Ok(())
}

/// Parse simctl JSON output into SimulatorInfo list, sorted (booted first, then by name).
pub fn parse_simctl_json(json_str: &str) -> Result<Vec<SimulatorInfo>, SimulatorError> {
    let json: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| SimulatorError::Simctl(format!("failed to parse simctl JSON: {}", e)))?;

    let devices = json["devices"]
        .as_object()
        .ok_or_else(|| SimulatorError::Simctl("no 'devices' key in simctl output".to_string()))?;

    let mut result = Vec::new();
    for (runtime, device_list) in devices {
        if let Some(arr) = device_list.as_array() {
            for dev in arr {
                let is_available = dev["isAvailable"].as_bool().unwrap_or(false);
                if !is_available {
                    continue;
                }
                result.push(SimulatorInfo {
                    name: dev["name"].as_str().unwrap_or("").to_string(),
                    udid: dev["udid"].as_str().unwrap_or("").to_string(),
                    state: dev["state"].as_str().unwrap_or("Unknown").to_string(),
                    runtime: runtime.clone(),
                    device_type: dev["deviceTypeIdentifier"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    is_available,
                });
            }
        }
    }

    // Sort: booted first, then by name
    result.sort_by(|a, b| {
        let a_booted = a.state == "Booted";
        let b_booted = b.state == "Booted";
        b_booted.cmp(&a_booted).then_with(|| a.name.cmp(&b.name))
    });

    Ok(result)
}

/// Create a new simulator via `xcrun simctl create`. Returns the new UDID.
pub async fn create_simulator(
    name: &str,
    device_type: &str,
    runtime: &str,
) -> Result<String, SimulatorError> {
    log::info!(
        "Creating simulator '{}' (type={}, runtime={})",
        name,
        device_type,
        runtime
    );
    let name_owned = name.to_string();
    let device_type_owned = device_type.to_string();
    let runtime_owned = runtime.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "create", &name_owned, &device_type_owned, &runtime_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl create failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SimulatorError::CreateFailed {
            name: name.to_string(),
            reason: stderr.trim().to_string(),
        });
    }

    let udid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::info!("Created simulator '{}' with UDID {}", name, udid);
    Ok(udid)
}

/// Erase a simulator's contents and settings (reset to clean state, keeps UDID).
pub async fn erase_simulator(udid: &str) -> Result<(), SimulatorError> {
    log::info!("Erasing simulator {}...", udid);
    let udid_owned = udid.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "erase", &udid_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl erase failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SimulatorError::EraseFailed {
            udid: udid.to_string(),
            reason: stderr.trim().to_string(),
        });
    }

    log::info!("Erased simulator {}", udid);
    Ok(())
}

/// Delete a simulator entirely.
pub async fn delete_simulator(udid: &str) -> Result<(), SimulatorError> {
    log::info!("Deleting simulator {}...", udid);
    let udid_owned = udid.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "delete", &udid_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl delete failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SimulatorError::DeleteFailed {
            udid: udid.to_string(),
            reason: stderr.trim().to_string(),
        });
    }

    log::info!("Deleted simulator {}", udid);
    Ok(())
}

/// Shutdown a running simulator.
pub async fn shutdown_simulator(udid: &str) -> Result<(), SimulatorError> {
    log::info!("Shutting down simulator {}...", udid);
    let udid_owned = udid.to_string();

    let output = tokio::task::spawn_blocking(move || {
        Command::new("xcrun")
            .args(["simctl", "shutdown", &udid_owned])
            .output()
            .map_err(|e| SimulatorError::Simctl(format!("simctl shutdown failed: {}", e)))
    })
    .await
    .map_err(|e| SimulatorError::Simctl(format!("task join failed: {}", e)))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "already shutdown" is not an error
        if stderr.contains("current state: Shutdown") {
            return Ok(());
        }
        return Err(SimulatorError::ShutdownFailed {
            udid: udid.to_string(),
            reason: stderr.trim().to_string(),
        });
    }

    log::info!("Shut down simulator {}", udid);
    Ok(())
}
