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
 *
 * DATA CORRUPTION FIX (2026-02-05):
 * - Was: Two independent BufReaders on the same fd (event listener via try_clone()
 *   and receive() via direct stream read) raced for bytes, causing JSON-RPC
 *   responses to be consumed by the wrong reader — data loss on cancelQuery(),
 *   getClaudeAuth(), workspaceInit() while streaming was active.
 * - Now: ALL reads go through the single event listener thread. JSON-RPC responses
 *   (messages with an "id" field) are dispatched via mpsc channel to receive().
 *   Notifications (no "id") are emitted as Tauri events as before.
 */

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use serde_json::Value;

/**
 * Socket Manager State
 *
 * Maintains connection to the sidecar Unix socket.
 *
 * All reads are funneled through the event listener thread to prevent
 * data corruption from concurrent BufReaders on the same fd.
 * JSON-RPC responses (with "id") are dispatched to response_rx for receive().
 * JSON-RPC notifications (without "id") are emitted as Tauri events.
 */
pub struct SocketManager {
    socket_path: Mutex<Option<PathBuf>>,
    stream: Arc<Mutex<Option<UnixStream>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    /// Channel receiver for JSON-RPC responses routed from the event listener.
    /// Created fresh in start_event_listener(), cleared in disconnect().
    response_rx: Arc<Mutex<Option<mpsc::Receiver<String>>>>,
}

impl SocketManager {
    pub fn new() -> Self {
        SocketManager {
            socket_path: Mutex::new(None),
            stream: Arc::new(Mutex::new(None)),
            app_handle: Arc::new(Mutex::new(None)),
            response_rx: Arc::new(Mutex::new(None)),
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
     * @param socket_path - Path to Unix socket (e.g., /tmp/opendevs-claude-12345.sock)
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

        // Disconnect existing connection before connecting to a different path
        // to avoid leaking the old stream and stale response channel.
        {
            let has_existing = self.stream.lock().unwrap().is_some();
            if has_existing {
                println!("[SOCKET] Disconnecting from previous socket before connecting to new path");
                let _ = self.disconnect();
            }
        }

        match UnixStream::connect(&path) {
            Ok(stream) => {
                *self.stream.lock().unwrap() = Some(stream);
                *self.socket_path.lock().unwrap() = Some(path);
                println!("[SOCKET] Connected to {}", socket_path);
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
     * Receive a JSON-RPC response from sidecar
     *
     * Instead of reading from the socket directly (which would race with the
     * event listener thread), this reads from the mpsc response channel that
     * the event listener populates with JSON-RPC response messages (those with
     * an "id" field).
     *
     * Uses a 30-second timeout to avoid hanging forever if the sidecar dies.
     */
    pub fn receive(&self) -> Result<String, String> {
        let rx_lock = self.response_rx.lock().unwrap();

        match rx_lock.as_ref() {
            Some(rx) => {
                // Use recv_timeout to avoid blocking forever if sidecar dies
                // or the connection is dropped while we're waiting.
                rx.recv_timeout(Duration::from_secs(30))
                    .map_err(|e| match e {
                        mpsc::RecvTimeoutError::Timeout => {
                            "Timed out waiting for response from sidecar (30s)".to_string()
                        }
                        mpsc::RecvTimeoutError::Disconnected => {
                            "Response channel disconnected (event listener stopped)".to_string()
                        }
                    })
            }
            None => Err("Not connected to socket (no response channel)".to_string()),
        }
    }

    /**
     * Start listening for broadcast events from sidecar-v2
     * Runs in background thread and emits Tauri events to frontend
     *
     * ALL socket reads are funneled through this single thread to prevent
     * data corruption from concurrent BufReaders on the same fd.
     *
     * Parses JSON-RPC 2.0 messages from sidecar-v2:
     * - Notifications (no "id"): emitted as Tauri events
     *   - {"jsonrpc":"2.0","method":"message","params":{...}} → "session:message" event
     *   - {"jsonrpc":"2.0","method":"queryError","params":{...}} → "session:error" event
     *   - {"jsonrpc":"2.0","method":"enterPlanModeNotification","params":{...}} → "session:enter-plan-mode" event
     * - Responses (has "id"): dispatched to mpsc channel for receive()
     */
    pub fn start_event_listener(&self) {
        // Create the mpsc channel for routing JSON-RPC responses to receive()
        let (response_tx, response_rx) = mpsc::channel::<String>();
        *self.response_rx.lock().unwrap() = Some(response_rx);

        let stream = Arc::clone(&self.stream);
        let app_handle = Arc::clone(&self.app_handle);

        thread::spawn(move || {
            println!("[SOCKET] Event listener started (JSON-RPC 2.0 mode)");

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
                                    let is_jsonrpc = rpc_msg.get("jsonrpc")
                                        .and_then(|v| v.as_str()) == Some("2.0");

                                    if !is_jsonrpc {
                                        continue;
                                    }

                                    // Dispatch based on message shape:
                                    // 1. Has "method" + "id" = sidecar→frontend REQUEST → emit Tauri event
                                    // 2. Has "id" but no "method" = response to frontend request → mpsc
                                    // 3. Has "method" but no "id" = notification → emit Tauri event
                                    let has_method = rpc_msg.get("method").and_then(|v| v.as_str()).is_some();
                                    let has_id = rpc_msg.get("id").is_some();

                                    if has_method && has_id {
                                        // Sidecar → Frontend REQUEST (bidirectional RPC)
                                        // The sidecar is requesting the frontend to do something
                                        // (e.g., eval JS in browser, ask user a question).
                                        // Emit as "sidecar:request" with full JSON-RPC envelope.
                                        let method = rpc_msg.get("method").and_then(|v| v.as_str()).unwrap_or("unknown");
                                        println!("[SOCKET] Sidecar request: {} (id={})", method,
                                            rpc_msg.get("id").map(|v| v.to_string()).unwrap_or_default());

                                        if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                                            let payload = serde_json::json!({
                                                "id": rpc_msg.get("id"),
                                                "method": method,
                                                "params": rpc_msg.get("params").cloned().unwrap_or(Value::Null),
                                            });
                                            if let Err(e) = handle.emit("sidecar:request", payload) {
                                                eprintln!("[SOCKET] Failed to emit sidecar request: {}", e);
                                            }
                                        }
                                    } else if has_id {
                                        // Response to frontend-initiated request → route to receive()
                                        let _ = response_tx.send(line);
                                    } else if has_method {
                                        // Notification — emit as Tauri event
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
                                                println!("[SOCKET] Unknown RPC notification: {}", method);
                                                continue;
                                            }
                                        };

                                        println!("[SOCKET] {} -> {}", method, event_name);

                                        // Emit to frontend via Tauri
                                        if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                                            if let Err(e) = handle.emit(event_name, params) {
                                                eprintln!("[SOCKET] Failed to emit event: {}", e);
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[SOCKET] Error reading line: {}", e);
                                // Clear the stream so we don't spin in a tight loop
                                // trying to read from a broken connection
                                *stream.lock().unwrap() = None;
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
        // Clear the response channel so receive() returns an error immediately
        // instead of blocking on a stale channel.
        *self.response_rx.lock().unwrap() = None;
        println!("[SOCKET] Disconnected");
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
