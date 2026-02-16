use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use std::thread;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySession {
    pub id: String,
    pub pid: u32,
}

struct PtySessionInternal {
    writer: Box<dyn Write + Send>,
    _reader_thread: thread::JoinHandle<()>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySessionInternal>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    pub fn spawn(&self, id: String, command: String, args: Vec<String>, cols: u16, rows: u16, cwd: Option<String>) -> anyhow::Result<String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(&command);
        cmd.args(args);

        if let Some(cwd_path) = cwd {
            cmd.cwd(cwd_path);
        }

        let _child = pair.slave.spawn_command(cmd)
            .map_err(|e| anyhow::anyhow!("Failed to spawn command: {}", e))?;

        // Get reader and writer
        let mut reader = pair.master.try_clone_reader()
            .map_err(|e| anyhow::anyhow!("Failed to clone reader: {}", e))?;
        let writer = pair.master.take_writer()
            .map_err(|e| anyhow::anyhow!("Failed to take writer: {}", e))?;

        // Spawn thread to read PTY output
        let session_id = id.clone();
        let app_handle = self.app_handle.clone();

        let reader_thread = thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        let data = buf[..n].to_vec();

                        // Emit event to frontend
                        if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                            let _ = handle.emit("pty-data", serde_json::json!({
                                "id": session_id,
                                "data": data
                            }));
                        }
                    }
                    Ok(_) => break, // EOF
                    Err(e) => {
                        eprintln!("Error reading from PTY: {}", e);
                        break;
                    }
                }
            }

            // PTY closed, emit exit event
            if let Some(handle) = app_handle.lock().unwrap().as_ref() {
                let _ = handle.emit("pty-exit", serde_json::json!({
                    "id": session_id,
                }));
            }
        });

        let session = PtySessionInternal {
            writer,
            _reader_thread: reader_thread,
        };

        self.sessions.lock().unwrap().insert(id.clone(), session);

        Ok(id)
    }

    pub fn resize(&self, _id: &str, _cols: u16, _rows: u16) -> anyhow::Result<()> {
        // Note: portable-pty doesn't expose resize directly on the writer
        // This is a limitation we'll document
        Ok(())
    }

    pub fn write(&self, id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();

        if let Some(session) = sessions.get_mut(id) {
            session.writer.write_all(&data)
                .map_err(|e| anyhow::anyhow!("Failed to write to PTY: {}", e))?;
            session.writer.flush()
                .map_err(|e| anyhow::anyhow!("Failed to flush PTY: {}", e))?;
            Ok(())
        } else {
            Err(anyhow::anyhow!("PTY instance not found: {}", id))
        }
    }

    pub fn kill(&self, id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();

        if let Some(session) = sessions.remove(id) {
            // Dropping the session will close the PTY
            drop(session);
            Ok(())
        } else {
            Err(anyhow::anyhow!("PTY instance not found: {}", id))
        }
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}
