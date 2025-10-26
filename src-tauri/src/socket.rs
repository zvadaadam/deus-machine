/**
 * Unix Domain Socket Client for Sidecar Communication
 *
 * Connects to the Node.js sidecar Unix socket for real-time
 * communication with Claude CLI.
 *
 * Architecture:
 * React → Tauri Rust (this file) → Unix Socket → Node Sidecar → Claude CLI
 */

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use serde_json::Value;

/**
 * Socket Manager State
 *
 * Maintains connection to the sidecar Unix socket
 */
pub struct SocketManager {
    socket_path: Mutex<Option<PathBuf>>,
    stream: Mutex<Option<UnixStream>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl SocketManager {
    pub fn new() -> Self {
        SocketManager {
            socket_path: Mutex::new(None),
            stream: Mutex::new(None),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /**
     * Set app handle for emitting Tauri events
     */
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    /**
     * Connect to the sidecar Unix socket
     *
     * @param socket_path - Path to Unix socket (e.g., /tmp/conductor-claude-12345.sock)
     */
    pub fn connect(&self, socket_path: String) -> Result<(), String> {
        let path = PathBuf::from(&socket_path);

        match UnixStream::connect(&path) {
            Ok(stream) => {
                *self.stream.lock().unwrap() = Some(stream);
                *self.socket_path.lock().unwrap() = Some(path);
                println!("[SOCKET] 🔌 Connected to {}", socket_path);
                Ok(())
            }
            Err(e) => Err(format!("Failed to connect to socket: {}", e)),
        }
    }

    /**
     * Send NDJSON message to sidecar
     *
     * @param message - JSON message to send
     */
    pub fn send(&self, message: String) -> Result<(), String> {
        let mut stream_lock = self.stream.lock().unwrap();

        match stream_lock.as_mut() {
            Some(stream) => {
                // NDJSON format: JSON + newline
                let ndjson = format!("{}\n", message);
                stream
                    .write_all(ndjson.as_bytes())
                    .map_err(|e| format!("Failed to send message: {}", e))?;
                stream
                    .flush()
                    .map_err(|e| format!("Failed to flush: {}", e))?;
                Ok(())
            }
            None => Err("Not connected to socket".to_string()),
        }
    }

    /**
     * Receive NDJSON message from sidecar
     *
     * @returns Next line from socket as string
     */
    pub fn receive(&self) -> Result<String, String> {
        let stream_lock = self.stream.lock().unwrap();

        match stream_lock.as_ref() {
            Some(stream) => {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .map_err(|e| format!("Failed to read from socket: {}", e))?;
                Ok(line.trim_end().to_string())
            }
            None => Err("Not connected to socket".to_string()),
        }
    }

    /**
     * Start listening for broadcast events from sidecar
     * Runs in background thread and emits Tauri events to frontend
     */
    pub fn start_event_listener(&self) {
        let stream = Arc::clone(&self.stream);
        let app_handle = Arc::clone(&self.app_handle);

        thread::spawn(move || {
            println!("[SOCKET] 📡 Event listener started");

            loop {
                // Check if we have a connection
                let socket_opt = {
                    let stream_guard = stream.lock().unwrap();
                    stream_guard.as_ref().and_then(|s| s.try_clone().ok())
                };

                if let Some(socket) = socket_opt {
                    let reader = BufReader::new(&socket);

                    for line in reader.lines() {
                        match line {
                            Ok(line) => {
                                // Try to parse as JSON event
                                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                                    // Check if it's a frontend_event type
                                    if event.get("type").and_then(|v| v.as_str()) == Some("frontend_event") {
                                        let event_name = event.get("event")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown");

                                        let payload = event.get("payload").cloned()
                                            .unwrap_or(Value::Null);

                                        println!("[SOCKET] 📢 Received event: {}", event_name);

                                        // Emit to frontend via Tauri
                                        if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                                            if let Err(e) = handle.emit(event_name, payload) {
                                                eprintln!("[SOCKET] ❌ Failed to emit event: {}", e);
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[SOCKET] ❌ Error reading line: {}", e);
                                break; // Connection lost, exit loop
                            }
                        }
                    }

                    // Wait a bit before checking again
                    thread::sleep(Duration::from_millis(100));
                } else {
                    // No connection - wait longer before retrying to avoid busy-wait
                    thread::sleep(Duration::from_secs(1));
                }
            }
        });
    }

    /**
     * Disconnect from socket
     */
    pub fn disconnect(&self) -> Result<(), String> {
        *self.stream.lock().unwrap() = None;
        *self.socket_path.lock().unwrap() = None;
        println!("[SOCKET] 🔌 Disconnected");
        Ok(())
    }

    /**
     * Check if connected
     */
    pub fn is_connected(&self) -> bool {
        self.stream.lock().unwrap().is_some()
    }
}

// Tauri commands are defined in commands.rs to keep them organized
