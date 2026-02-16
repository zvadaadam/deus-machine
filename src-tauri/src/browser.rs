use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use anyhow::{Result, Context};

/// Browser Manager
///
/// Manages the dev-browser HTTP server as a child process.
/// This runs the MCP browser automation server that provides
/// Playwright-powered browser control with accessibility features.
pub struct BrowserManager {
    process: Mutex<Option<Child>>,
    port: Arc<Mutex<Option<u16>>>,
    auth_token: Arc<Mutex<Option<String>>>,
}

impl BrowserManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            port: Arc::new(Mutex::new(None)),
            auth_token: Arc::new(Mutex::new(None)),
        }
    }

    /// Start the dev-browser HTTP server
    pub fn start(&self, dev_browser_path: PathBuf) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if process.is_some() {
            println!("[BROWSER] Browser server already running");
            return Ok(());
        }

        println!("[BROWSER] Starting dev-browser HTTP server at {}", dev_browser_path.display());

        // Run bun run start:http with PORT=0 for dynamic port allocation
        let mut child = Command::new("bun")
            .arg("run")
            .arg("start:http")
            .env("PORT", "0")  // Use port 0 for dynamic allocation (avoids conflicts)
            .current_dir(&dev_browser_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context(format!("Failed to start dev-browser at {}", dev_browser_path.display()))?;

        println!("[BROWSER] Browser server started with PID: {}", child.id());

        // Take stdout to read the port and auth token
        let stdout = child.stdout.take()
            .context("Failed to capture browser server stdout")?;

        // Clone Arcs for thread
        let port_clone = Arc::clone(&self.port);
        let token_clone = Arc::clone(&self.auth_token);

        // Spawn thread to read stdout and find port/token
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut looking_for_port_json = false;

            for line in reader.lines() {
                if let Ok(line) = line {
                    // Print all output for debugging
                    println!("[BROWSER] {}", line);

                    // Parse port from "Server URL: http://localhost:PORT" (after fix)
                    if line.contains("Server URL:") && line.contains("localhost:") {
                        if let Some(url_part) = line.split("localhost:").nth(1) {
                            let port_str = url_part.trim();
                            if let Ok(port_num) = port_str.parse::<u16>() {
                                let mut port = port_clone.lock().unwrap();
                                *port = Some(port_num);
                                println!("[BROWSER] ✓ Detected port: {}", port_num);
                            }
                        }
                    }

                    // Alternative: Parse from "PORT:3000" format if added
                    if line.starts_with("PORT:") {
                        if let Some(port_str) = line.strip_prefix("PORT:") {
                            if let Ok(port_num) = port_str.trim().parse::<u16>() {
                                let mut port = port_clone.lock().unwrap();
                                *port = Some(port_num);
                                println!("[BROWSER] ✓ Detected port: {}", port_num);
                            }
                        }
                    }

                    // Fallback: Parse from JSON (in case logger output is captured)
                    if line.contains("HTTP MCP Server started") {
                        looking_for_port_json = true;
                        continue;
                    }
                    if looking_for_port_json && line.trim().starts_with("\"port\":") {
                        if let Some(port_str) = line.split(':').nth(1) {
                            let port_str = port_str.trim().trim_end_matches(',');
                            if let Ok(port_num) = port_str.parse::<u16>() {
                                let mut port = port_clone.lock().unwrap();
                                *port = Some(port_num);
                                println!("[BROWSER] ✓ Detected port: {}", port_num);
                                looking_for_port_json = false;
                            }
                        }
                    }

                    // Parse auth token from "Auth Token: TOKEN"
                    if line.starts_with("Auth Token:") {
                        if let Some(token) = line.strip_prefix("Auth Token:") {
                            let mut auth = token_clone.lock().unwrap();
                            *auth = Some(token.trim().to_string());
                            println!("[BROWSER] ✓ Auth token detected");
                        }
                    }
                }
            }
        });

        *process = Some(child);

        // Wait for port to be detected (with timeout)
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(10) {
            if self.port.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if self.port.lock().unwrap().is_none() {
            eprintln!("[BROWSER] Warning: Could not detect browser server port within 10 seconds");
        }

        Ok(())
    }

    /// Get the actual port the browser server is running on
    pub fn get_port(&self) -> Option<u16> {
        *self.port.lock().unwrap()
    }

    /// Get the auth token for the browser server
    pub fn get_auth_token(&self) -> Option<String> {
        self.auth_token.lock().unwrap().clone()
    }

    /// Check if browser server is running
    pub fn is_running(&self) -> bool {
        let mut lock = self.process.lock().unwrap();
        if let Some(child) = lock.as_mut() {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    // Process exited; clear handle
                    *lock = None;
                    false
                }
                Ok(None) => true,  // Still running
                Err(_) => false,   // Error checking status
            }
        } else {
            false
        }
    }

    /// Stop the browser server
    pub fn stop(&self) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if let Some(mut child) = process.take() {
            println!("[BROWSER] Stopping browser server (PID: {})", child.id());
            child.kill().context("Failed to kill browser server process")?;
            child.wait().ok();
            println!("[BROWSER] Browser server stopped");
        }

        // Clear port and token
        *self.port.lock().unwrap() = None;
        *self.auth_token.lock().unwrap() = None;

        Ok(())
    }
}

impl Drop for BrowserManager {
    fn drop(&mut self) {
        // Ensure browser server is stopped when manager is dropped
        self.stop().ok();
    }
}
