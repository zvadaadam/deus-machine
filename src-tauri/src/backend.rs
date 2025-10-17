use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use anyhow::{Result, Context};

/// Backend Manager
///
/// Manages the Node.js Express backend as a child process.
/// This ensures the backend starts when the app starts and
/// stops when the app closes - proper Tauri lifecycle management.
///
/// The backend now uses dynamic port allocation. The actual port
/// is discovered by parsing stdout from the Node.js process.
pub struct BackendManager {
    process: Mutex<Option<Child>>,
    port: Arc<Mutex<Option<u16>>>,
}

impl BackendManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            port: Arc::new(Mutex::new(None)),
        }
    }

    /// Start the backend server with dynamic port allocation
    pub fn start(&self, backend_path: PathBuf) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if process.is_some() {
            println!("[BACKEND] Backend already running");
            return Ok(());
        }

        println!("[BACKEND] Starting Node.js backend at {}", backend_path.display());

        // Spawn backend with stdout captured to read the assigned port
        let mut child = Command::new("node")
            .arg(&backend_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context(format!("Failed to start backend at {}", backend_path.display()))?;

        println!("[BACKEND] Backend started with PID: {}", child.id());

        // Take stdout to read the port
        let stdout = child.stdout.take()
            .context("Failed to capture backend stdout")?;

        // Clone Arc for thread
        let port_clone = Arc::clone(&self.port);

        // Spawn thread to read stdout and find port
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
            child.wait().ok(); // Wait for process to finish
            println!("[BACKEND] Backend stopped");
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
