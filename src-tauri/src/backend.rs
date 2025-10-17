use std::process::{Child, Command};
use std::sync::Mutex;
use std::path::PathBuf;
use anyhow::{Result, Context};

/// Backend Manager
///
/// Manages the Node.js Express backend as a child process.
/// This ensures the backend starts when the app starts and
/// stops when the app closes - proper Tauri lifecycle management.
pub struct BackendManager {
    process: Mutex<Option<Child>>,
    port: u16,
}

impl BackendManager {
    pub fn new(port: u16) -> Self {
        Self {
            process: Mutex::new(None),
            port,
        }
    }

    /// Start the backend server
    pub fn start(&self, backend_path: PathBuf) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if process.is_some() {
            println!("[BACKEND] Backend already running");
            return Ok(());
        }

        println!("[BACKEND] Starting Node.js backend at {}", backend_path.display());

        let child = Command::new("node")
            .arg(&backend_path)
            .env("PORT", self.port.to_string())
            .spawn()
            .context(format!("Failed to start backend at {}", backend_path.display()))?;

        println!("[BACKEND] Backend started with PID: {}", child.id());
        *process = Some(child);

        // Give backend a moment to start
        std::thread::sleep(std::time::Duration::from_millis(1000));

        Ok(())
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
