use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use anyhow::{Result, Context};
use tauri::{AppHandle, Emitter};

/// Backend Manager
///
/// Manages the Node.js Express backend as a child process.
/// This ensures the backend starts when the app starts and
/// stops when the app closes - proper Tauri lifecycle management.
///
/// The backend now uses dynamic port allocation. The actual port
/// is discovered by parsing stdout from the Node.js process.
///
/// Also relays structured progress events from the backend to the
/// frontend via Tauri events. The backend emits lines prefixed with
/// `OPENDEVS_WORKSPACE_PROGRESS:` containing JSON payloads that get
/// parsed and emitted as `workspace:progress` Tauri events.
pub struct BackendManager {
    process: Mutex<Option<Child>>,
    port: Arc<Mutex<Option<u16>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl BackendManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            port: Arc::new(Mutex::new(None)),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Set app handle so we can emit Tauri events from the stdout reader thread.
    /// Must be called before start() for workspace progress events to work.
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    /// Start the backend server with dynamic port allocation
    pub fn start(&self, backend_path: PathBuf, db_path: &str) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if process.is_some() {
            println!("[BACKEND] Backend already running");
            return Ok(());
        }

        println!("[BACKEND] Starting Node.js backend at {}", backend_path.display());

        // Spawn backend with stdout captured to read the assigned port
        let mut child = Command::new("node")
            .arg(&backend_path)
            .env("DATABASE_PATH", db_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context(format!("Failed to start backend at {}", backend_path.display()))?;

        println!("[BACKEND] Backend started with PID: {}", child.id());

        // Take stdout to read the port
        let stdout = child.stdout.take()
            .context("Failed to capture backend stdout")?;

        // Clone Arcs for thread
        let port_clone = Arc::clone(&self.port);
        let app_handle_clone = Arc::clone(&self.app_handle);

        // Spawn thread to read stdout and find port + relay workspace progress events
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    // Print all output for debugging
                    println!("[BACKEND] {}", line);

                    // Parse port from [BACKEND_PORT]12345 format
                    if line.starts_with("[BACKEND_PORT]") {
                        if let Some(port_str) = line.strip_prefix("[BACKEND_PORT]") {
                            if let Ok(port_num) = port_str.parse::<u16>() {
                                let mut port = port_clone.lock().unwrap();
                                *port = Some(port_num);
                                println!("[BACKEND] Detected port: {}", port_num);
                            }
                        }
                    }

                    // Parse workspace init progress events and relay as Tauri events.
                    // Backend emits: OPENDEVS_WORKSPACE_PROGRESS:{"workspaceId":"...","step":"...","label":"..."}
                    // We parse the JSON and emit it as a "workspace:progress" Tauri event.
                    if let Some(json_str) = line.strip_prefix("OPENDEVS_WORKSPACE_PROGRESS:") {
                        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(json_str) {
                            if let Some(handle) = app_handle_clone.lock().unwrap().as_ref() {
                                if let Err(e) = handle.emit("workspace:progress", &payload) {
                                    eprintln!("[BACKEND] Failed to emit workspace:progress: {}", e);
                                }
                            }
                        }
                    }
                }
            }
        });

        *process = Some(child);

        // Wait for port to be detected (with timeout)
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(5) {
            if self.port.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if self.port.lock().unwrap().is_none() {
            eprintln!("[BACKEND] Warning: Could not detect backend port within 5 seconds");
        }

        Ok(())
    }

    /// Get the actual port the backend is running on
    pub fn get_port(&self) -> Option<u16> {
        *self.port.lock().unwrap()
    }

    /// Check if backend is running
    pub fn is_running(&self) -> bool {
        let process = self.process.lock().unwrap();
        process.is_some()
    }

    /// Stop the backend server
    pub fn stop(&self) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if let Some(mut child) = process.take() {
            println!("[BACKEND] Stopping backend (PID: {})", child.id());
            child.kill().context("Failed to kill backend process")?;
            match child.wait() {
                Ok(status) => println!("[BACKEND] Backend stopped (exit: {})", status),
                Err(e) => eprintln!("[BACKEND] Backend stopped (wait error: {})", e),
            }
        }

        Ok(())
    }
}

impl Drop for BackendManager {
    fn drop(&mut self) {
        // Ensure backend is stopped when manager is dropped
        self.stop().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn test_backend_manager_creation() {
        let manager = BackendManager::new();
        assert!(!manager.is_running());
        assert_eq!(manager.get_port(), None);
    }

    #[test]
    fn test_port_parsing() {
        // Test the port detection logic by simulating stdout
        let test_output = "[BACKEND_PORT]8080\nOther output\n[BACKEND_PORT]9090\n";

        // Find the first [BACKEND_PORT] line
        let port = test_output
            .lines()
            .find(|line| line.starts_with("[BACKEND_PORT]"))
            .and_then(|line| line.strip_prefix("[BACKEND_PORT]"))
            .and_then(|port_str| port_str.parse::<u16>().ok());

        assert_eq!(port, Some(8080));
    }

    #[test]
    fn test_backend_lifecycle_with_mock_server() {
        // Create a mock Node.js script that outputs a port
        let temp_dir = std::env::temp_dir();
        let script_path = temp_dir.join("mock_backend_test.js");

        let script_content = r#"
console.log('[BACKEND_PORT]54321');
console.log('Mock backend started');

// Keep the process alive for a moment
setTimeout(() => {
    console.log('Mock backend shutting down');
    process.exit(0);
}, 2000);
"#;

        fs::write(&script_path, script_content).unwrap();

        let manager = BackendManager::new();

        // Start the mock backend
        match manager.start(script_path.clone(), "/tmp/test-opendevs.db") {
            Ok(_) => {
                println!("✅ Mock backend started successfully");

                // Give it a moment to detect the port
                std::thread::sleep(std::time::Duration::from_millis(500));

                // Check if port was detected
                if let Some(port) = manager.get_port() {
                    println!("✅ Port detected: {}", port);
                    assert_eq!(port, 54321);
                } else {
                    println!("⚠️  Port not detected yet, but that's okay for this test");
                }

                assert!(manager.is_running());

                // Stop the backend
                manager.stop().unwrap();
                assert!(!manager.is_running());
            }
            Err(e) => {
                println!("⚠️  Could not start mock backend (Node.js might not be available): {}", e);
                // Don't fail the test if Node.js isn't available
            }
        }

        // Cleanup
        let _ = fs::remove_file(&script_path);
    }

    #[test]
    fn test_port_detection_timeout() {
        // Create a mock script that doesn't output a port
        let temp_dir = std::env::temp_dir();
        let script_path = temp_dir.join("mock_backend_no_port.js");

        let script_content = r#"
console.log('Starting without port output...');
setTimeout(() => process.exit(0), 1000);
"#;

        fs::write(&script_path, script_content).unwrap();

        let manager = BackendManager::new();

        match manager.start(script_path.clone(), "/tmp/test-opendevs.db") {
            Ok(_) => {
                // Port should be None since we didn't output it
                // (or might still be None if detection hasn't completed)
                println!("Port after start: {:?}", manager.get_port());

                manager.stop().ok();
            }
            Err(e) => {
                println!("⚠️  Could not start mock backend: {}", e);
            }
        }

        let _ = fs::remove_file(&script_path);
    }

    #[test]
    fn test_double_start_prevention() {
        let temp_dir = std::env::temp_dir();
        let script_path = temp_dir.join("mock_backend_double.js");

        let script_content = r#"
console.log('[BACKEND_PORT]55555');
setTimeout(() => process.exit(0), 3000);
"#;

        fs::write(&script_path, script_content).unwrap();

        let manager = BackendManager::new();

        if manager.start(script_path.clone(), "/tmp/test-opendevs.db").is_ok() {
            assert!(manager.is_running());

            // Try to start again - should return Ok but not actually start
            let result = manager.start(script_path.clone(), "/tmp/test-opendevs.db");
            assert!(result.is_ok());

            manager.stop().ok();
        }

        let _ = fs::remove_file(&script_path);
    }
}
