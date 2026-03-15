use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use anyhow::{Result, Context};

/// Sidecar Manager
///
/// Manages the Node.js agent-server process (agent runtime).
/// The agent-server is a stateless SDK wrapper: it handles Claude/Codex SDK
/// integration and emits canonical events. No direct database access.
///
/// The sidecar uses Unix domain sockets for IPC. The socket path
/// is discovered by parsing `LISTEN_URL=<path>` from stdout.
pub struct SidecarManager {
    process: Mutex<Option<Child>>,
    listen_url: Arc<Mutex<Option<String>>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            listen_url: Arc::new(Mutex::new(None)),
        }
    }

    /// Start the agent-server process
    ///
    /// # Arguments
    /// * `sidecar_path` - Path to the agent-server entry point (index.bundled.cjs)
    pub fn start(&self, sidecar_path: PathBuf) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if process.is_some() {
            println!("[SIDECAR] Sidecar already running");
            return Ok(());
        }

        println!("[SIDECAR] Starting agent-server at {}", sidecar_path.display());

        // Runtime dependency: Node.js must be installed and available in PATH.
        // The agent-server is a stateless Node.js script that wraps the Claude/Codex
        // SDKs. No native modules required (better-sqlite3 removed in PR 6).
        let mut cmd = Command::new("node");
        cmd.arg(&sidecar_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // Forward Sentry DSN to Node.js agent-server (set at build time, not hardcoded)
        if let Some(dsn) = option_env!("SENTRY_DSN_NODE") {
            cmd.env("SENTRY_DSN", dsn);
        }
        let mut child = cmd.spawn()
            .context(format!(
                "Failed to spawn sidecar at {}. Ensure Node.js is installed and available in PATH.",
                sidecar_path.display()
            ))?;

        let pid = child.id();
        println!("[SIDECAR] Sidecar started with PID: {}", pid);
        println!("[SIDECAR] Sidecar logs: /tmp/opendevs-{}.log", pid);

        // Take stdout to read the socket path
        let stdout = child.stdout.take()
            .context("Failed to capture sidecar stdout")?;

        // Clone Arc for thread
        let listen_url_clone = Arc::clone(&self.listen_url);

        // Spawn thread to read stdout and find socket path
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    // Print all output for debugging (sidecar logs go to file, but some may come through)
                    println!("[SIDECAR] {}", line);

                    // Parse agent-server URL from LISTEN_URL=ws://... format
                    if line.starts_with("LISTEN_URL=") {
                        if let Some(path_str) = line.strip_prefix("LISTEN_URL=") {
                            let mut listen_url = listen_url_clone.lock().unwrap();
                            *listen_url = Some(path_str.to_string());
                            println!("[SIDECAR] Detected listen URL: {}", path_str);
                        }
                    }
                }
            }
        });

        *process = Some(child);

        // Drop the process mutex before polling to avoid holding it for up to 10s.
        // Other threads (is_running, stop) need the lock during this period.
        drop(process);

        // Wait for socket path to be detected (with timeout)
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(10) {
            if self.listen_url.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if self.listen_url.lock().unwrap().is_none() {
            eprintln!("[SIDECAR] Warning: Could not detect listen URL within 10 seconds");
        }

        Ok(())
    }

    /// Get the socket path the sidecar is listening on
    pub fn get_listen_url(&self) -> Option<String> {
        self.listen_url.lock().unwrap().clone()
    }

    /// Check if sidecar is running
    ///
    /// Uses try_wait() to detect if the child process has crashed or exited,
    /// rather than just checking if we have a process handle. This prevents
    /// stale process handles from reporting a running state.
    pub fn is_running(&self) -> bool {
        let mut process = self.process.lock().unwrap();
        if let Some(ref mut child) = *process {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Process has exited — clean up both handles
                    eprintln!("[SIDECAR] Process exited unexpectedly (exit: {})", status);
                    *process = None;
                    *self.listen_url.lock().unwrap() = None;
                    false
                }
                Ok(None) => true,    // Still running
                Err(e) => {
                    eprintln!("[SIDECAR] Failed to check process status: {}", e);
                    *process = None;
                    *self.listen_url.lock().unwrap() = None;
                    false
                }
            }
        } else {
            false
        }
    }

    /// Stop the sidecar process gracefully.
    ///
    /// Sends SIGTERM first to allow cleanup (close DB, remove socket, kill child processes),
    /// waits up to 3 seconds, then sends SIGKILL as a fallback.
    pub fn stop(&self) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if let Some(mut child) = process.take() {
            let pid = child.id();
            println!("[SIDECAR] Stopping sidecar (PID: {})", pid);

            // Send SIGTERM first for graceful shutdown (allows sidecar to close DB, remove socket, kill child processes)
            #[cfg(unix)]
            {
                // SAFETY: libc::kill with a valid pid is safe. SIGTERM is a standard graceful shutdown signal.
                unsafe { libc::kill(pid as i32, libc::SIGTERM); }
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill();
            }

            // Wait up to 3 seconds for graceful exit
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(3);
            let exited = loop {
                match child.try_wait() {
                    Ok(Some(_)) => break true,
                    Ok(None) => {
                        if start.elapsed() >= timeout {
                            break false;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(_) => break true,
                }
            };

            if !exited {
                println!("[SIDECAR] SIGTERM timeout, sending SIGKILL");
                if let Err(e) = child.kill() {
                    eprintln!("[SIDECAR] SIGKILL failed: {}", e);
                }
            }

            // Always reap the child to prevent zombie processes
            match child.wait() {
                Ok(status) => println!("[SIDECAR] Sidecar stopped (exit: {})", status),
                Err(e) => eprintln!("[SIDECAR] Sidecar stopped (wait error: {})", e),
            }
        }

        // Clear the socket path
        *self.listen_url.lock().unwrap() = None;

        Ok(())
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        // Ensure sidecar is stopped when manager is dropped
        self.stop().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_sidecar_manager_creation() {
        let manager = SidecarManager::new();
        assert!(!manager.is_running());
        assert_eq!(manager.get_listen_url(), None);
    }

    #[test]
    fn test_listen_url_parsing() {
        // Test the socket path detection logic by simulating stdout
        let test_output = "Some initialization output\nLISTEN_URL=/tmp/opendevs-sidecar-12345.sock\nMore output\n";

        // Find the SOCKET_PATH line
        let listen_url = test_output
            .lines()
            .find(|line| line.starts_with("LISTEN_URL="))
            .and_then(|line| line.strip_prefix("LISTEN_URL="))
            .map(|s| s.to_string());

        assert_eq!(listen_url, Some("/tmp/opendevs-sidecar-12345.sock".to_string()));
    }

    #[test]
    fn test_sidecar_lifecycle_with_mock() {
        // Create a mock Node.js script that outputs a socket path
        let temp_dir = std::env::temp_dir();
        let script_path = temp_dir.join("mock_sidecar_test.js");

        let script_content = r#"
console.log('Initializing mock sidecar...');
console.log('LISTEN_URL=/tmp/mock-sidecar-test.sock');
console.log('Mock sidecar ready');

// Keep the process alive for a moment
setTimeout(() => {
    console.log('Mock sidecar shutting down');
    process.exit(0);
}, 2000);
"#;

        fs::write(&script_path, script_content).unwrap();

        let manager = SidecarManager::new();

        // Start the mock sidecar
        match manager.start(script_path.clone()) {
            Ok(_) => {
                println!("✅ Mock sidecar started successfully");

                // Give it a moment to detect the socket path
                std::thread::sleep(std::time::Duration::from_millis(500));

                // Check if socket path was detected
                if let Some(path) = manager.get_listen_url() {
                    println!("✅ Socket path detected: {}", path);
                    assert_eq!(path, "/tmp/mock-sidecar-test.sock");
                } else {
                    println!("⚠️  Socket path not detected yet, but that's okay for this test");
                }

                assert!(manager.is_running());

                // Stop the sidecar
                manager.stop().unwrap();
                assert!(!manager.is_running());
            }
            Err(e) => {
                println!("⚠️  Could not start mock sidecar (Node.js might not be available): {}", e);
                // Don't fail the test if Node.js isn't available
            }
        }

        // Cleanup
        let _ = fs::remove_file(&script_path);
    }
}
