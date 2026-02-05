/**
 * Unix Domain Socket Client for Sidecar-v2 Communication
 *
 * Connects to the Node.js sidecar-v2 Unix socket for real-time
 * communication with agent runtime (Claude SDK, Codex, etc.).
 *
 * ARCHITECTURE (Event Flow):
 * Frontend → Tauri IPC → Rust socket relay → Sidecar-v2 → Claude SDK
 * Claude responds → Sidecar-v2 saves to DB → Sidecar-v2 JSON-RPC notify
 * → Rust listener (here) reads → Rust emits Tauri event → Frontend
 * → UI updates instantly (<100ms latency)
 *
 * PROTOCOL: JSON-RPC 2.0 over newline-delimited JSON (NDJSON)
 * Notifications from sidecar-v2:
 * - "message": Agent message (streaming responses)
 * - "queryError": Query error notification
 * - "enterPlanModeNotification": Plan mode entry
 *
 * DESIGN DECISION - Why Unix Socket vs HTTP SSE:
 * - Infrastructure already existed (sidecar uses Unix socket)
 * - Tauri event system proven working (PTY integration)
 * - No HTTP overhead for desktop app
 * - ~150 lines vs ~200+ for SSE implementation
 *
 * PERFORMANCE FIX (2025-10-26):
 * - Was: Busy-wait loop checking connection every 100ms (high CPU when disconnected)
 * - Now: Sleep 1s when disconnected, 100ms when connected (90% CPU reduction)
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
    stream: Arc<Mutex<Option<UnixStream>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl SocketManager {
    pub fn new() -> Self {
        SocketManager {
            socket_path: Mutex::new(None),
            stream: Arc::new(Mutex::new(None)),
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

        // Skip if already connected to the same socket path.
        // This prevents the frontend's useSocket() from creating a second
        // connection that splits reads (event listener) and writes (send).
        {
            let current_path = self.socket_path.lock().unwrap();
            if let Some(ref existing) = *current_path {
                if existing == &path {
                    println!("[SOCKET] Already connected to {}", socket_path);
                    return Ok(());
                }
            }
        }

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
     * Start listening for broadcast events from sidecar-v2
     * Runs in background thread and emits Tauri events to frontend
     *
     * Parses JSON-RPC 2.0 notifications from sidecar-v2:
     * - {"jsonrpc":"2.0","method":"message","params":{...}} → "session:message" event
     * - {"jsonrpc":"2.0","method":"queryError","params":{...}} → "session:error" event
     * - {"jsonrpc":"2.0","method":"enterPlanModeNotification","params":{...}} → "session:enter-plan-mode" event
     */
    pub fn start_event_listener(&self) {
        let stream = Arc::clone(&self.stream);
        let app_handle = Arc::clone(&self.app_handle);

        thread::spawn(move || {
            println!("[SOCKET] 📡 Event listener started (JSON-RPC 2.0 mode)");

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
                                // Try to parse as JSON-RPC 2.0 message
                                if let Ok(rpc_msg) = serde_json::from_str::<Value>(&line) {
                                    // Check for JSON-RPC 2.0 notification (no "id" field)
                                    if rpc_msg.get("jsonrpc").and_then(|v| v.as_str()) == Some("2.0")
                                        && rpc_msg.get("id").is_none()
                                    {
                                        let method = rpc_msg.get("method")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown");

                                        let params = rpc_msg.get("params").cloned()
                                            .unwrap_or(Value::Null);

                                        // Map JSON-RPC methods to Tauri event names
                                        let event_name = match method {
                                            "message" => "session:message",
                                            "queryError" => "session:error",
                                            "enterPlanModeNotification" => "session:enter-plan-mode",
                                            _ => {
                                                println!("[SOCKET] ⚠️ Unknown RPC method: {}", method);
                                                continue;
                                            }
                                        };

                                        println!("[SOCKET] 📢 {} → {}", method, event_name);

                                        // Emit to frontend via Tauri
                                        if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                                            if let Err(e) = handle.emit(event_name, params) {
                                                eprintln!("[SOCKET] ❌ Failed to emit event: {}", e);
                                            }
                                        }
                                    }
                                    // JSON-RPC requests/responses are handled by send/receive methods
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
