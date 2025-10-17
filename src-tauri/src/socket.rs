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
use std::sync::Mutex;
use tauri::State;

/**
 * Socket Manager State
 *
 * Maintains connection to the sidecar Unix socket
 */
pub struct SocketManager {
    socket_path: Mutex<Option<PathBuf>>,
    stream: Mutex<Option<UnixStream>>,
}

impl SocketManager {
    pub fn new() -> Self {
        SocketManager {
            socket_path: Mutex::new(None),
            stream: Mutex::new(None),
        }
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
