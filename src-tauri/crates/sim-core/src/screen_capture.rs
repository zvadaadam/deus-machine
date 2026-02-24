use std::ffi::{c_void, CString};
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use bytes::Bytes;
use tokio::sync::watch;

use hive_sim_sys as bridge;

// ============================================================================
// MARK: - RadonTouchServer (simulator-server binary for touch injection)
// ============================================================================

/// Manages the Radon `simulator-server-macos` subprocess for reliable touch injection.
///
/// Radon IDE ships a pre-compiled binary that handles touch/gesture injection via
/// a simple stdin line protocol. This is the PRIMARY touch path — IndigoHID via
/// the ObjC bridge is the FALLBACK (broken on some macOS versions).
struct RadonTouchServer {
    process: Child,
}

impl RadonTouchServer {
    fn new(udid: &str) -> Result<Self, String> {
        let radon_binary = find_radon_binary()
            .ok_or_else(|| "simulator-server binary not found in Cursor or VSCode extensions".to_string())?;

        log::info!("[RadonTouch] Starting simulator-server: {}", radon_binary);

        let process = Command::new(&radon_binary)
            .args(["ios", "--id", udid])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn simulator-server: {}", e))?;

        log::info!("[RadonTouch] simulator-server started with PID: {}", process.id());

        // Give it time to initialize
        std::thread::sleep(std::time::Duration::from_millis(500));

        Ok(Self { process })
    }

    /// Send a touch event via the stdin protocol.
    /// Coordinates are normalized [0.0, 1.0]. Format: `touch {Down|Move|Up} x,y\n`
    fn send_touch(&mut self, x: f64, y: f64, touch_type: &str) -> Result<(), String> {
        let stdin = self.process.stdin.as_mut()
            .ok_or_else(|| "simulator-server stdin not available".to_string())?;

        let cmd = format!("touch {} {:.4},{:.4}\n", touch_type, x, y);
        log::debug!("[RadonTouch] Sending: {}", cmd.trim());

        stdin.write_all(cmd.as_bytes())
            .map_err(|e| format!("Failed to write touch command: {}", e))?;
        stdin.flush()
            .map_err(|e| format!("Failed to flush touch command: {}", e))?;

        Ok(())
    }
}

impl Drop for RadonTouchServer {
    fn drop(&mut self) {
        log::info!("[RadonTouch] Stopping simulator-server");
        let _ = self.process.kill();
    }
}

/// Find the Radon simulator-server binary by searching Cursor and VSCode extension dirs.
fn find_radon_binary() -> Option<String> {
    let home = std::env::var("HOME").ok()?;

    // Search order: Cursor extensions first, then VSCode
    let search_dirs = [
        format!("{}/.cursor/extensions", home),
        format!("{}/.vscode/extensions", home),
    ];

    for ext_dir in &search_dirs {
        if let Some(path) = find_simulator_server_in(ext_dir) {
            return Some(path);
        }
    }

    None
}

/// Search an extensions directory for the simulator-server binary.
/// Finds `swmansion.react-native-ide-*/dist/simulator-server-macos` and
/// returns the one from the highest semantic version.
fn find_simulator_server_in(extensions_dir: &str) -> Option<String> {
    let dir = std::fs::read_dir(extensions_dir).ok()?;
    let prefix = "swmansion.react-native-ide-";

    let mut candidates: Vec<(String, (u64, u64, u64))> = Vec::new();

    for entry in dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if !name_str.starts_with(prefix) {
            continue;
        }

        let binary_path = entry.path().join("dist").join("simulator-server-macos");
        if !binary_path.exists() {
            continue;
        }

        let version = extract_semver_from_dirname(&name_str);
        let path_str = binary_path.to_string_lossy().into_owned();

        if let Some(ver) = version {
            candidates.push((path_str, ver));
        } else {
            // No version parsed — still a valid candidate with lowest priority
            candidates.push((path_str, (0, 0, 0)));
        }
    }

    // Sort by version descending, pick the highest
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    candidates.into_iter().next().map(|(path, _)| path)
}

/// Extract (major, minor, patch) from a directory name like
/// `swmansion.react-native-ide-1.15.1-darwin-arm64`.
fn extract_semver_from_dirname(dirname: &str) -> Option<(u64, u64, u64)> {
    let prefix = "swmansion.react-native-ide-";
    let rest = dirname.strip_prefix(prefix)?;
    // rest is "1.15.1-darwin-arm64" — take everything before the first '-'
    let version_str = rest.split('-').next()?;
    let parts: Vec<&str> = version_str.split('.').collect();
    if parts.len() == 3 {
        let major = parts[0].parse::<u64>().ok()?;
        let minor = parts[1].parse::<u64>().ok()?;
        let patch = parts[2].parse::<u64>().ok()?;
        Some((major, minor, patch))
    } else {
        None
    }
}

/// Context passed through the C FFI callback as an opaque pointer.
struct CallbackContext {
    frame_tx: watch::Sender<Bytes>,
    frame_count: AtomicU64,
    /// Timestamp of the last FPS log (for time-based FPS measurement)
    fps_window_start: std::sync::Mutex<Instant>,
    /// Frame count at the start of the current FPS window
    fps_window_count: AtomicU64,
}

/// Manages the lifecycle of an iOS simulator screen capture session.
///
/// Uses `tokio::sync::watch` for frame delivery — the watch channel always holds
/// the latest JPEG frame, so consumers never miss updates (unlike Notify which
/// can silently drop notifications when the consumer is busy).
pub struct ScreenCapture {
    handle: bridge::SimBridgeHandle,
    frame_tx: watch::Sender<Bytes>,
    frame_rx: watch::Receiver<Bytes>,
    // Must be kept alive as long as the callback is registered
    _callback_context: Option<Box<CallbackContext>>,
    // Screen dimensions
    _screen_width: f64,
    _screen_height: f64,
    // Radon simulator-server subprocess for touch injection (primary path)
    radon_touch: Option<RadonTouchServer>,
}

// The handle is a raw pointer to ObjC objects managed on the ObjC side.
// We only access it from the main thread or via the bridge functions
// which handle their own thread safety.
unsafe impl Send for ScreenCapture {}

impl ScreenCapture {
    pub fn new(udid: &str) -> Result<Self, String> {
        let c_udid = CString::new(udid).map_err(|e| e.to_string())?;
        let mut error_buf = vec![0u8; 1024];

        let handle = unsafe {
            bridge::sim_bridge_create(
                c_udid.as_ptr(),
                error_buf.as_mut_ptr() as *mut i8,
                error_buf.len() as i32,
            )
        };

        if handle.is_null() {
            let error_msg = unsafe {
                std::ffi::CStr::from_ptr(error_buf.as_ptr() as *const i8)
                    .to_string_lossy()
                    .into_owned()
            };
            return Err(format!("Failed to connect to simulator: {}", error_msg));
        }

        // Create the watch channel (latest-value-only, never misses)
        let (frame_tx, frame_rx) = watch::channel(Bytes::new());

        // Get screen dimensions from the bridge
        let mut width: f64 = 1640.0;  // Default
        let mut height: f64 = 2360.0;
        unsafe {
            bridge::sim_bridge_get_screen_size(handle, &mut width, &mut height);
        }

        // Try to start the Radon simulator-server for touch injection (primary path).
        // Falls back to IndigoHID via ObjC bridge if unavailable.
        let radon_touch = match RadonTouchServer::new(udid) {
            Ok(server) => {
                log::info!("[ScreenCapture] Radon touch server initialized — touch via simulator-server");
                Some(server)
            }
            Err(e) => {
                log::warn!("[ScreenCapture] Radon touch server unavailable (will use IndigoHID fallback): {}", e);
                None
            }
        };

        Ok(Self {
            handle,
            frame_tx,
            frame_rx,
            _callback_context: None,
            _screen_width: width,
            _screen_height: height,
            radon_touch,
        })
    }

    /// Start receiving frames. The callback writes JPEG data into the watch channel.
    /// Safe to call multiple times — subsequent calls are no-ops.
    pub fn start(&mut self) -> Result<(), String> {
        if self._callback_context.is_some() {
            log::warn!("Screen capture already started — ignoring duplicate start()");
            return Ok(());
        }

        let ctx = Box::new(CallbackContext {
            frame_tx: self.frame_tx.clone(),
            frame_count: AtomicU64::new(0),
            fps_window_start: std::sync::Mutex::new(Instant::now()),
            fps_window_count: AtomicU64::new(0),
        });

        let ctx_ptr = Box::into_raw(ctx);

        let success = unsafe {
            bridge::sim_bridge_register_frame_callback(
                self.handle,
                frame_callback_trampoline,
                ctx_ptr as *mut c_void,
            )
        };

        if !success {
            // Reclaim the box to avoid leaking
            unsafe {
                let _ = Box::from_raw(ctx_ptr);
            }
            return Err("Failed to register frame callback".to_string());
        }

        // Keep the context alive (it will be freed in Drop)
        self._callback_context = Some(unsafe { Box::from_raw(ctx_ptr) });

        log::info!("Screen capture started");
        Ok(())
    }

    /// Get a new watch receiver for the frame stream.
    /// Each call returns a fresh receiver that will see the latest frame
    /// and all subsequent frames. Multiple consumers can subscribe independently.
    pub fn subscribe(&self) -> watch::Receiver<Bytes> {
        self.frame_rx.clone()
    }

    /// Send a touch event. Uses Radon simulator-server as primary path,
    /// falls back to IndigoHID via ObjC bridge if unavailable.
    /// Coordinates are normalized [0.0, 1.0]. Phase: 0=began, 1=moved, 2=ended.
    pub fn send_touch(&mut self, x: f64, y: f64, phase: i32) -> bool {
        // Convert phase to touch type string for Radon protocol
        let touch_type = match phase {
            0 => "Down",
            1 => "Move",
            2 => "Up",
            _ => return false,
        };

        // PRIMARY: Use Radon simulator-server if available (proven working)
        if let Some(ref mut radon) = self.radon_touch {
            match radon.send_touch(x, y, touch_type) {
                Ok(_) => {
                    log::debug!("[Touch] Sent via Radon: {} at ({:.3}, {:.3})", touch_type, x, y);
                    return true;
                }
                Err(e) => {
                    log::warn!("[Touch] Radon failed (falling back to IndigoHID): {}", e);
                }
            }
        }

        // FALLBACK: IndigoHID via ObjC bridge
        let result = unsafe { bridge::sim_bridge_send_touch(self.handle, x, y, phase) };
        if result {
            log::debug!("[Touch] Sent via IndigoHID: {} at ({:.3}, {:.3})", touch_type, x, y);
        } else {
            log::warn!("[Touch] IndigoHID also failed for {} at ({:.3}, {:.3})", touch_type, x, y);
        }
        result
    }

    /// Send a scroll/wheel event.
    pub fn send_scroll(&self, x: f64, y: f64, dx: f64, dy: f64) -> bool {
        log::debug!("Scroll at ({:.3}, {:.3}) delta: ({:.2}, {:.2})", x, y, dx, dy);
        unsafe { bridge::sim_bridge_send_scroll(self.handle, x, y, dx, dy) }
    }

    /// Send a keyboard event.
    pub fn send_key(&self, keycode: u16, direction: i32) -> bool {
        log::debug!("Key 0x{:04x} direction={}", keycode, direction);
        unsafe { bridge::sim_bridge_send_key(self.handle, keycode, direction) }
    }

    /// Send a hardware button event.
    pub fn send_button(&self, button_type: i32, direction: i32) -> bool {
        log::debug!("Button type={} direction={}", button_type, direction);
        unsafe { bridge::sim_bridge_send_button(self.handle, button_type, direction) }
    }

    /// Take a screenshot and return JPEG data.
    pub fn screenshot(&self) -> Option<Vec<u8>> {
        // First call to get required size
        let size = unsafe { bridge::sim_bridge_screenshot(self.handle, std::ptr::null_mut(), 0) };
        if size == 0 {
            return None;
        }

        // Allocate buffer and capture
        let mut buffer = vec![0u8; size as usize];
        let actual_size = unsafe {
            bridge::sim_bridge_screenshot(self.handle, buffer.as_mut_ptr(), size)
        };

        if actual_size == 0 {
            return None;
        }

        buffer.truncate(actual_size as usize);
        Some(buffer)
    }

    /// Press the Home button using keyboard shortcut.
    pub fn press_home(&self) -> bool {
        unsafe { bridge::sim_bridge_press_home(self.handle) }
    }

    /// Check whether HID client was initialized (required for touch/scroll/key).
    pub fn is_hid_available(&self) -> bool {
        unsafe { bridge::sim_bridge_is_hid_available(self.handle) }
    }
}

impl Drop for ScreenCapture {
    fn drop(&mut self) {
        log::info!("Destroying screen capture");
        // Kill Radon subprocess first (before ObjC bridge teardown)
        if let Some(radon) = self.radon_touch.take() {
            drop(radon);
        }
        unsafe {
            bridge::sim_bridge_destroy(self.handle);
        }
    }
}

/// C-compatible callback function called from the ObjC dispatch queue.
/// Sends JPEG frame data through the watch channel so the MJPEG server
/// always sees the latest frame without missing notifications.
extern "C" fn frame_callback_trampoline(
    context: *mut c_void,
    jpeg_data: *const u8,
    jpeg_length: u64,
) {
    if context.is_null() || jpeg_data.is_null() || jpeg_length == 0 {
        return;
    }

    let ctx = unsafe { &*(context as *const CallbackContext) };

    // Copy the JPEG bytes from ObjC memory into a Bytes buffer
    let data = unsafe { std::slice::from_raw_parts(jpeg_data, jpeg_length as usize) };
    let frame = Bytes::copy_from_slice(data);

    // Send through watch channel — receivers always see the latest frame.
    // If no one is listening, the value is still stored for when they next check.
    let _ = ctx.frame_tx.send(frame);

    // Time-based FPS logging (every 2 seconds)
    let count = ctx.frame_count.fetch_add(1, Ordering::Relaxed) + 1;
    let window_frames = ctx.fps_window_count.fetch_add(1, Ordering::Relaxed) + 1;

    if count == 1 {
        log::info!("[FrameRate] First frame delivered ({} bytes)", jpeg_length);
    }

    if let Ok(mut start) = ctx.fps_window_start.try_lock() {
        let elapsed = start.elapsed();
        if elapsed.as_secs() >= 2 {
            let fps = window_frames as f64 / elapsed.as_secs_f64();
            log::info!(
                "[FrameRate] {:.1} FPS (encode→watch) | {} total frames | ~{}KB/frame",
                fps,
                count,
                jpeg_length / 1024
            );
            *start = Instant::now();
            ctx.fps_window_count.store(0, Ordering::Relaxed);
        }
    }
}
