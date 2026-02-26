use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use std::io::{BufRead, BufReader};
use anyhow::{Result, Context};

/// Gateway Manager
///
/// Manages the Node.js messaging gateway process.
/// The gateway bridges Telegram/WhatsApp to the OpenDevs backend and sidecar,
/// enabling remote agent interaction from messaging platforms.
///
/// Optional — only spawns if at least one messaging channel is configured
/// (TELEGRAM_BOT_TOKEN or WHATSAPP_SESSION_DIR).
pub struct GatewayManager {
    process: Mutex<Option<Child>>,
    ready: Arc<Mutex<bool>>,
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            ready: Arc::new(Mutex::new(false)),
        }
    }

    /// Start the gateway process
    ///
    /// # Arguments
    /// * `gateway_path` - Path to the gateway entry point (index.bundled.cjs or index.ts)
    /// * `backend_url` - URL of the running OpenDevs backend (e.g. http://localhost:50123)
    /// * `sidecar_socket_path` - Path to the sidecar Unix domain socket
    /// * `telegram_bot_token` - Optional Telegram bot token
    /// * `whatsapp_session_dir` - Optional WhatsApp session directory
    pub fn start(
        &self,
        gateway_path: PathBuf,
        backend_url: &str,
        sidecar_socket_path: &str,
        telegram_bot_token: Option<&str>,
        whatsapp_session_dir: Option<&str>,
    ) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if process.is_some() {
            println!("[GATEWAY] Gateway already running");
            return Ok(());
        }

        // At least one channel must be configured
        if telegram_bot_token.is_none() && whatsapp_session_dir.is_none() {
            println!("[GATEWAY] No messaging channels configured, skipping gateway start");
            return Ok(());
        }

        println!("[GATEWAY] Starting gateway at {}", gateway_path.display());

        // Dev mode: use `bun` to run TypeScript directly (zero build step).
        // Production: use `node` with the pre-bundled CJS file (gateway.bundled.cjs).
        // Mirrors the sidecar pattern — see sidecar.rs for reference.
        let runtime = if cfg!(dev) { "bun" } else { "node" };
        let mut cmd = Command::new(runtime);
        cmd.arg(&gateway_path)
            .env("BACKEND_URL", backend_url)
            .env("SIDECAR_SOCKET_PATH", sidecar_socket_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // Set optional env vars
        if let Some(token) = telegram_bot_token {
            cmd.env("TELEGRAM_BOT_TOKEN", token);
        }
        if let Some(dir) = whatsapp_session_dir {
            cmd.env("WHATSAPP_SESSION_DIR", dir);
        }

        let mut child = cmd.spawn().context(format!(
            "Failed to spawn gateway at {}. Ensure Node.js is installed and available in PATH.",
            gateway_path.display()
        ))?;

        let pid = child.id();
        println!("[GATEWAY] Gateway started with PID: {}", pid);

        // Take stdout to read the ready signal
        let stdout = child.stdout.take()
            .context("Failed to capture gateway stdout")?;

        let ready_clone = Arc::clone(&self.ready);

        // Spawn thread to read stdout and detect GATEWAY_READY
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("[GATEWAY] {}", line);

                    if line.starts_with("GATEWAY_READY") {
                        let mut ready = ready_clone.lock().unwrap();
                        *ready = true;
                        println!("[GATEWAY] Gateway is ready");
                    }
                }
            }
        });

        *process = Some(child);

        // Drop process lock before polling
        drop(process);

        // Wait for ready signal (with timeout)
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_secs(15) {
            if *self.ready.lock().unwrap() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if !*self.ready.lock().unwrap() {
            eprintln!("[GATEWAY] Warning: Gateway did not signal ready within 15 seconds");
        }

        Ok(())
    }

    /// Check if gateway is running
    pub fn is_running(&self) -> bool {
        let mut process = self.process.lock().unwrap();
        if let Some(ref mut child) = *process {
            match child.try_wait() {
                Ok(Some(status)) => {
                    eprintln!("[GATEWAY] Process exited unexpectedly (exit: {})", status);
                    *process = None;
                    *self.ready.lock().unwrap() = false;
                    false
                }
                Ok(None) => true,
                Err(e) => {
                    eprintln!("[GATEWAY] Failed to check process status: {}", e);
                    *process = None;
                    *self.ready.lock().unwrap() = false;
                    false
                }
            }
        } else {
            false
        }
    }

    /// Stop the gateway process gracefully.
    ///
    /// Sends SIGTERM first, waits up to 3 seconds, then SIGKILL as fallback.
    pub fn stop(&self) -> Result<()> {
        let mut process = self.process.lock().unwrap();

        if let Some(mut child) = process.take() {
            let pid = child.id();
            println!("[GATEWAY] Stopping gateway (PID: {})", pid);

            #[cfg(unix)]
            {
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
                println!("[GATEWAY] SIGTERM timeout, sending SIGKILL");
                if let Err(e) = child.kill() {
                    eprintln!("[GATEWAY] SIGKILL failed: {}", e);
                }
            }

            // Always reap the child to prevent zombie processes
            match child.wait() {
                Ok(status) => println!("[GATEWAY] Gateway stopped (exit: {})", status),
                Err(e) => eprintln!("[GATEWAY] Gateway stopped (wait error: {})", e),
            }
        }

        *self.ready.lock().unwrap() = false;

        Ok(())
    }
}

impl Drop for GatewayManager {
    fn drop(&mut self) {
        self.stop().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gateway_manager_creation() {
        let manager = GatewayManager::new();
        assert!(!manager.is_running());
    }

    #[test]
    fn test_gateway_skips_without_channels() {
        let manager = GatewayManager::new();
        // Should succeed but do nothing (no channels configured)
        let result = manager.start(
            PathBuf::from("/nonexistent/gateway.cjs"),
            "http://localhost:50000",
            "/tmp/sidecar.sock",
            None,
            None,
        );
        assert!(result.is_ok());
        assert!(!manager.is_running());
    }
}
