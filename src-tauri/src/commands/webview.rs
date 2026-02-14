/**
 * Webview commands — manage native child webviews for the embedded browser.
 *
 * Uses Tauri v2 multi-webview (unstable) to create real WKWebView instances
 * inside the main window. Unlike iframes, native webviews bypass
 * X-Frame-Options restrictions so they can load any URL.
 *
 * Architecture: React renders a placeholder <div>, measures its bounds
 * via ResizeObserver, and tells Rust to position a native webview there.
 * Callbacks (on_page_load, on_navigation, on_document_title_changed)
 * emit Tauri events that the React frontend listens to.
 *
 * Console capture: An initialization_script injected into every page load
 * intercepts console.log/warn/error/debug and buffers them. SPA navigation
 * (pushState/replaceState) is detected via a title-channel bridge — the
 * script temporarily sets document.title to a conductor-prefixed message,
 * which triggers on_document_title_changed in Rust and emits events.
 */

use serde::Deserialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use url::Url;

#[cfg(target_os = "macos")]
use std::sync::mpsc as std_mpsc;

/// JavaScript injected into every page load via initialization_script().
/// Captures console output, runtime errors, and SPA navigation events.
/// Uses document.title as a side-channel to communicate with Rust since
/// window.__TAURI__ is not available in child webviews loading external URLs.
///
/// Title-channel protocol uses \x01 (SOH) prefix — NOT \x00 (NUL).
/// NUL bytes cause C string truncation in WKWebView's NSString → Rust String
/// conversion (via UTF8String → CStr), silently dropping the entire message.
const BROWSER_INIT_SCRIPT: &str = r#"(function(){
  // Console capture — intercept and buffer
  var B = window.__CONDUCTOR_LOGS__ = [];
  var _l=console.log, _w=console.warn, _e=console.error, _d=console.debug;
  function F(lv, args) {
    try {
      var m = Array.from(args).map(function(a) {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch(e) { return String(a); }
        }
        return String(a);
      }).join(' ');
      B.push({l:lv, m:m, t:Date.now()});
      if (B.length > 200) B.splice(0, B.length - 200);
    } catch(e) {}
  }
  console.log = function(){ F('info',arguments); _l.apply(console,arguments); };
  console.warn = function(){ F('warn',arguments); _w.apply(console,arguments); };
  console.error = function(){ F('error',arguments); _e.apply(console,arguments); };
  console.debug = function(){ F('debug',arguments); _d.apply(console,arguments); };

  // Runtime error capture
  window.addEventListener('error', function(e) {
    F('error', [e.message + (e.filename ? ' at ' + e.filename + ':' + e.lineno : '')]);
  });
  window.addEventListener('unhandledrejection', function(e) {
    var r = e.reason;
    F('error', [r instanceof Error ? r.message : String(r || 'Unhandled rejection')]);
  });

  // SPA navigation detection via title-channel bridge
  // Uses setTimeout to restore the original title in the next event loop tick,
  // preventing WKWebView from coalescing the title changes (which would cause
  // the \x01CN: message to be silently dropped before reaching the Rust KVO).
  var _push = history.pushState.bind(history);
  var _repl = history.replaceState.bind(history);
  var _origTitle = '';
  function notifyNav() {
    try {
      _origTitle = document.title;
      document.title = '\x01CN:' + location.href;
      setTimeout(function() { document.title = _origTitle; }, 0);
    } catch(e) {}
  }
  history.pushState = function(){ _push.apply(history, arguments); notifyNav(); };
  history.replaceState = function(){ _repl.apply(history, arguments); notifyNav(); };
  window.addEventListener('popstate', notifyNav);
  window.addEventListener('hashchange', notifyNav);

  // Intercept target="_blank" links — navigate in same webview instead of
  // silently failing (WKWebView has no new-window handler by default)
  document.addEventListener('click', function(e) {
    var link = e.target.closest ? e.target.closest('a') : null;
    if (!link) return;
    var target = link.getAttribute('target');
    if (target === '_blank' || target === '_new') {
      var href = link.href;
      if (href && href !== '#' && !href.startsWith('javascript:')) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = href;
      }
    }
  }, true);

  // Intercept window.open() — navigate in same webview
  var _wopen = window.open;
  window.open = function(url, target, features) {
    if (url && typeof url === 'string' && url !== '' && url !== 'about:blank') {
      try { var u = new URL(url, location.href); window.location.href = u.href; } catch(e) {}
      return window;
    }
    return _wopen.apply(window, arguments);
  };
})();"#;

/// Create a native child webview inside the main window.
///
/// The webview is positioned at the given logical coordinates (matching
/// getBoundingClientRect() values from the React placeholder div).
/// Registers callbacks that emit events to the frontend.
/// Injects an initialization script for console capture and SPA nav detection.
#[tauri::command]
pub async fn create_browser_webview(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    window_label: Option<String>,
) -> Result<(), String> {
    // Get the target window handle (requires "unstable" feature).
    // Defaults to "main" for backward compatibility; pass "browser-detached"
    // when the browser is popped out into a separate window.
    let target = window_label.as_deref().unwrap_or("main");
    let window = app
        .get_window(target)
        .ok_or_else(|| format!("Window '{}' not found", target))?;

    // Parse URL — default to about:blank if empty
    let webview_url = if url.is_empty() {
        WebviewUrl::External("about:blank".parse().unwrap())
    } else {
        let parsed: Url = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
        WebviewUrl::External(parsed)
    };

    // Clone app handle for use in closures
    let app_for_load = app.clone();
    let app_for_title = app.clone();
    let label_for_load = label.clone();
    let label_for_title = label.clone();

    let builder = tauri::webview::WebviewBuilder::new(&label, webview_url)
        // Allow all navigations — the whole point is to load any URL
        .on_navigation(|_url| true)
        // Inject console capture + SPA nav detection into every page load
        .initialization_script(BROWSER_INIT_SCRIPT)
        // Emit page load events to the frontend
        .on_page_load(move |_webview, payload| {
            let event_type = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
                _ => return,
            };
            app_for_load
                .emit(
                    "browser:page-load",
                    serde_json::json!({
                        "label": label_for_load,
                        "url": payload.url().to_string(),
                        "event": event_type,
                    }),
                )
                .ok();
        })
        // Detect conductor messages in title changes (SPA nav, console drain)
        .on_document_title_changed(move |_webview, title| {
            // SPA navigation: "\x01CN:{url}"
            if title.starts_with("\x01CN:") {
                let url = &title[4..];
                app_for_title
                    .emit(
                        "browser:url-change",
                        serde_json::json!({
                            "label": label_for_title,
                            "url": url,
                        }),
                    )
                    .ok();
                return;
            }

            // Console log drain: "\x01CL:{json_array}"
            if title.starts_with("\x01CL:") {
                let json_str = &title[4..];
                app_for_title
                    .emit(
                        "browser:console",
                        serde_json::json!({
                            "label": label_for_title,
                            "logs": json_str,
                        }),
                    )
                    .ok();
                return;
            }

            // Eval result: "\x01CR:{requestId}:{json_data}"
            // Used by browser automation tools to get JS execution results back
            if title.starts_with("\x01CR:") {
                let payload = &title[4..];
                // Split on first ':' to separate requestId from data
                if let Some(colon_pos) = payload.find(':') {
                    let request_id = &payload[..colon_pos];
                    let data = &payload[colon_pos + 1..];
                    app_for_title
                        .emit(
                            "browser:eval-result",
                            serde_json::json!({
                                "label": label_for_title,
                                "requestId": request_id,
                                "data": data,
                            }),
                        )
                        .ok();
                }
                return;
            }

            // Element selected in inspect mode: "\x01CE:{json}"
            // Emitted when user clicks an element or drag-selects an area
            if title.starts_with("\x01CE:") {
                let json_str = &title[4..];
                app_for_title
                    .emit(
                        "browser:element-selected",
                        serde_json::json!({
                            "label": label_for_title,
                            "data": json_str,
                        }),
                    )
                    .ok();
                return;
            }

            // Selection mode state change: "\x01CS:{json}"
            // Emitted when inspect mode is enabled/disabled
            if title.starts_with("\x01CS:") {
                let json_str = &title[4..];
                app_for_title
                    .emit(
                        "browser:selection-mode",
                        serde_json::json!({
                            "label": label_for_title,
                            "data": json_str,
                        }),
                    )
                    .ok();
                return;
            }

            // Regular title change — emit for tab title update
            // Ignore empty titles and restored titles (brief flicker from channel)
            if !title.is_empty() {
                app_for_title
                    .emit(
                        "browser:title-changed",
                        serde_json::json!({
                            "label": label_for_title,
                            "title": title,
                        }),
                    )
                    .ok();
            }
        })
        // Enable devtools in debug builds
        .devtools(cfg!(debug_assertions))
        // Transparent background to match the app aesthetic
        .transparent(true);

    // Create the child webview at the specified position
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    Ok(())
}

/// Navigate an existing browser webview to a new URL.
#[tauri::command]
pub async fn navigate_browser_webview(
    app: AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let parsed: Url = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("Navigation failed: {}", e))
}

/// Update the position and size of a browser webview.
///
/// Called by the frontend ResizeObserver when the placeholder div changes.
/// Coordinates are logical (CSS pixels), matching getBoundingClientRect().
#[tauri::command]
pub async fn set_browser_webview_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(x, y)),
            size: tauri::Size::Logical(LogicalSize::new(width, height)),
        })
        .map_err(|e| format!("Failed to set bounds: {}", e))
}

/// Show a hidden browser webview.
#[tauri::command]
pub async fn show_browser_webview(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    webview
        .show()
        .map_err(|e| format!("Failed to show webview: {}", e))
}

/// Hide a browser webview (keeps it alive but invisible).
#[tauri::command]
pub async fn hide_browser_webview(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    webview
        .hide()
        .map_err(|e| format!("Failed to hide webview: {}", e))
}

/// Close and destroy a browser webview.
#[tauri::command]
pub async fn close_browser_webview(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| {
            // Already closed — not an error (cleanup on unmount may race)
            format!("Webview '{}' not found (may already be closed)", label)
        })?;

    webview
        .close()
        .map_err(|e| format!("Failed to close webview: {}", e))
}

/// Get the current URL of a browser webview.
#[tauri::command]
pub async fn get_browser_webview_url(app: AppHandle, label: String) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    webview
        .url()
        .map(|u| u.to_string())
        .map_err(|e| format!("Failed to get URL: {}", e))
}

/// Execute JavaScript in a browser webview's context (fire-and-forget).
///
/// Use this for JS that doesn't need a return value (e.g., visual effects setup,
/// cursor hiding, inspect mode injection). For JS that needs to return a result,
/// use `eval_browser_webview_with_result` instead.
#[tauri::command]
pub async fn eval_browser_webview(
    app: AppHandle,
    label: String,
    js: String,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    webview
        .eval(&js)
        .map_err(|e| format!("Failed to eval JS: {}", e))
}

/// Execute JavaScript in a browser webview and return the result.
///
/// Uses WKWebView's native `evaluateJavaScript:completionHandler:` via the
/// Objective-C runtime to get the JS result directly — bypassing the unreliable
/// title-channel bridge which suffers from title-change coalescing in WKWebView's
/// multi-process architecture.
///
/// The JS expression should evaluate to a string (typically a JSON.stringify call).
/// Non-string results are converted via their `description` (toString equivalent).
#[tauri::command]
pub async fn eval_browser_webview_with_result(
    app: AppHandle,
    label: String,
    js: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("Webview '{}' not found", label))?;

        let (tx, rx) = std_mpsc::channel::<Result<String, String>>();
        let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(30000));

        webview
            .with_webview(move |platform_wv| {
                let raw_ptr = platform_wv.inner() as *mut std::ffi::c_void;
                eval_js_wkwebview(raw_ptr, &js, tx);
            })
            .map_err(|e| format!("Failed to access webview: {}", e))?;

        rx.recv_timeout(timeout)
            .map_err(|e| format!("JS eval timed out: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, js, timeout_ms);
        Err("eval_browser_webview_with_result is only supported on macOS".to_string())
    }
}

/// Reload a browser webview.
#[tauri::command]
pub async fn reload_browser_webview(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Reload by re-navigating to the current URL
    let current_url = webview
        .url()
        .map_err(|e| format!("Failed to get current URL: {}", e))?;

    webview
        .navigate(current_url)
        .map_err(|e| format!("Failed to reload: {}", e))
}

/// Drain buffered console logs from a browser webview.
///
/// Evals a script that reads the __CONDUCTOR_LOGS__ buffer, clears it,
/// and sends the data via the title-channel bridge (\x01CL:{json}).
/// The on_document_title_changed callback catches this and emits
/// a "browser:console" Tauri event.
#[tauri::command]
pub async fn drain_browser_console(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Uses setTimeout to restore title in next tick — prevents WKWebView
    // from coalescing the title changes (same fix as SPA navigation detection).
    webview
        .eval(
            r#"(function(){
                var b = window.__CONDUCTOR_LOGS__ || [];
                window.__CONDUCTOR_LOGS__ = [];
                if(b.length > 0) {
                    var t = document.title;
                    document.title = '\x01CL:' + JSON.stringify(b);
                    setTimeout(function() { document.title = t; }, 0);
                }
            })()"#,
        )
        .map_err(|e| format!("Failed to drain console: {}", e))
}

/// Cookie data from the frontend (matches DecryptedCookie from cookies.rs).
/// Kept as a separate struct to avoid coupling webview commands to cookie module.
#[derive(Debug, Deserialize)]
pub struct CookieData {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: String,
    pub expires: i64,
}

/// Inject cookies into a browser webview's native cookie store.
///
/// Uses Tauri's Webview::set_cookie() which calls WKHTTPCookieStore on macOS.
/// This handles **all** cookies including HttpOnly — unlike document.cookie
/// which can only set non-HttpOnly cookies.
///
/// After injection, the page should be reloaded so the browser sends
/// the new cookies with subsequent requests.
#[tauri::command]
pub async fn inject_browser_cookies(
    app: AppHandle,
    label: String,
    cookies: Vec<CookieData>,
) -> Result<usize, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let mut injected = 0;

    for c in &cookies {
        // Build cookie using the `cookie` crate (re-exported by Tauri)
        let same_site = match c.same_site.as_str() {
            "none" => tauri::webview::cookie::SameSite::None,
            "strict" => tauri::webview::cookie::SameSite::Strict,
            _ => tauri::webview::cookie::SameSite::Lax,
        };

        let mut builder = tauri::webview::cookie::Cookie::build((&*c.name, &*c.value))
            .domain(c.domain.clone())
            .path(c.path.clone())
            .secure(c.secure)
            .http_only(c.http_only)
            .same_site(same_site);

        // Convert Chromium expires_utc (microseconds since 1601-01-01) to Unix timestamp
        if c.expires > 0 {
            let unix_seconds = (c.expires / 1_000_000) - 11_644_473_600;
            if let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(unix_seconds) {
                builder = builder.expires(dt);
            }
        }

        let cookie = builder.build();

        if let Err(e) = webview.set_cookie(cookie) {
            // Log but don't fail — some cookies may be rejected by the store
            eprintln!("Failed to set cookie '{}': {}", c.name, e);
            continue;
        }
        injected += 1;
    }

    Ok(injected)
}

/// Capture a screenshot of a browser webview as base64-encoded JPEG.
///
/// Uses WKWebView.takeSnapshot() on macOS for pixel-perfect capture of the
/// rendered page, including cross-origin content and dynamically rendered elements.
/// Returns a base64-encoded JPEG string (no data URI prefix).
///
/// Optional `rect_x/rect_y/rect_width/rect_height` crop to a specific region
/// (CSS points). When omitted, captures the full visible viewport.
#[tauri::command]
pub async fn screenshot_browser_webview(
    app: AppHandle,
    label: String,
    rect_x: Option<f64>,
    rect_y: Option<f64>,
    rect_width: Option<f64>,
    rect_height: Option<f64>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("Webview '{}' not found", label))?;

        // Build optional crop rect (CSS points)
        let crop = match (rect_x, rect_y, rect_width, rect_height) {
            (Some(x), Some(y), Some(w), Some(h)) if w > 0.0 && h > 0.0 => Some((x, y, w, h)),
            _ => None,
        };

        let (tx, rx) = std_mpsc::channel::<Result<String, String>>();

        webview
            .with_webview(move |platform_wv| {
                let raw_ptr = platform_wv.inner() as *mut std::ffi::c_void;
                screenshot_wkwebview(raw_ptr, tx, crop);
            })
            .map_err(|e| format!("Failed to access webview: {}", e))?;

        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| format!("Screenshot timed out: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, rect_x, rect_y, rect_width, rect_height);
        Err("Screenshots are only supported on macOS".to_string())
    }
}

/// Native macOS implementation: calls WKWebView.takeSnapshot(with:completionHandler:)
/// via the Objective-C runtime, converts the resulting NSImage to JPEG, and base64-encodes it.
///
/// `crop`: optional (x, y, w, h) in CSS points to capture only a region.
#[cfg(target_os = "macos")]
fn screenshot_wkwebview(
    raw_ptr: *mut std::ffi::c_void,
    tx: std_mpsc::Sender<Result<String, String>>,
    crop: Option<(f64, f64, f64, f64)>,
) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use block::ConcreteBlock;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize { width: f64, height: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect { origin: CGPoint, size: CGSize }

    unsafe {
        let wk: *mut Object = raw_ptr as *mut Object;
        if wk.is_null() {
            tx.send(Err("WKWebView pointer is null".to_string())).ok();
            return;
        }

        // Create WKSnapshotConfiguration — capture at 1x CSS pixel size
        // (not 2x Retina) to reduce image size for AI consumption.
        let config_cls = class!(WKSnapshotConfiguration);
        let config: *mut Object = msg_send![config_cls, new];

        // If a crop rect is provided, set it on the configuration so WebKit
        // only renders that region. Otherwise capture the full viewport.
        let snapshot_width = if let Some((x, y, w, h)) = crop {
            let rect = CGRect {
                origin: CGPoint { x, y },
                size: CGSize { width: w, height: h },
            };
            let _: () = msg_send![config, setRect: rect];
            w  // snapshot width = cropped region width (1x)
        } else {
            let bounds: CGRect = msg_send![wk, bounds];
            bounds.size.width  // full viewport width (1x)
        };

        // Set snapshotWidth to CSS point width (1x, not 2x Retina).
        if snapshot_width > 0.0 {
            let ns_number_cls = class!(NSNumber);
            let sw: *mut Object =
                msg_send![ns_number_cls, numberWithDouble: snapshot_width];
            let _: () = msg_send![config, setSnapshotWidth: sw];
        }

        // Completion handler: (NSImage?, NSError?) -> Void
        // Called by WebKit on the main thread when the screenshot is ready.
        let block = ConcreteBlock::new(move |image: *mut Object, error: *mut Object| {
            if image.is_null() {
                let err = if !error.is_null() {
                    let desc: *mut Object = msg_send![error, localizedDescription];
                    nsstring_to_rust(desc).unwrap_or_else(|| "Unknown error".to_string())
                } else {
                    "Screenshot returned null image".to_string()
                };
                tx.send(Err(err)).ok();
                return;
            }

            // NSImage → TIFFRepresentation → NSBitmapImageRep → JPEG data
            let tiff: *mut Object = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                tx.send(Err("Failed to get TIFF representation".to_string())).ok();
                return;
            }

            let bitmap_cls = class!(NSBitmapImageRep);
            let bitmap: *mut Object = msg_send![bitmap_cls, imageRepWithData: tiff];
            if bitmap.is_null() {
                tx.send(Err("Failed to create bitmap rep".to_string())).ok();
                return;
            }

            // JPEG format with 50% quality — good enough for AI visual analysis,
            // roughly 4-5x smaller than default (~90%) quality.
            let jpeg_type: usize = 3; // NSBitmapImageFileTypeJPEG
            let ns_number_cls = class!(NSNumber);
            let quality: *mut Object =
                msg_send![ns_number_cls, numberWithDouble: 0.5_f64];
            let props_cls = class!(NSDictionary);
            let compression_key = nsstring_create("NSImageCompressionFactor");
            let props: *mut Object = msg_send![props_cls,
                dictionaryWithObject: quality forKey: compression_key];
            let jpeg_data: *mut Object =
                msg_send![bitmap, representationUsingType: jpeg_type properties: props];
            if jpeg_data.is_null() {
                tx.send(Err("Failed to encode JPEG".to_string())).ok();
                return;
            }

            let length: usize = msg_send![jpeg_data, length];
            let bytes: *const u8 = msg_send![jpeg_data, bytes];
            if bytes.is_null() {
                tx.send(Err("Screenshot failed: null bytes pointer".into())).ok();
                return;
            }
            let data = std::slice::from_raw_parts(bytes, length);

            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(data);
            tx.send(Ok(b64)).ok();
        });
        let block = block.copy();

        let _: () =
            msg_send![wk, takeSnapshotWithConfiguration: config completionHandler: &*block];
    }
}

/// Execute JavaScript in a WKWebView and capture the result via the native
/// evaluateJavaScript:completionHandler: API.
///
/// This is the reliable path for getting JS results from WKWebView. Unlike the
/// title-channel approach (document.title side-channel), this uses WebKit's built-in
/// completion handler which doesn't suffer from title-change coalescing.
#[cfg(target_os = "macos")]
fn eval_js_wkwebview(
    raw_ptr: *mut std::ffi::c_void,
    js: &str,
    tx: std_mpsc::Sender<Result<String, String>>,
) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    use block::ConcreteBlock;

    unsafe {
        let wk: *mut Object = raw_ptr as *mut Object;
        if wk.is_null() {
            tx.send(Err("WKWebView pointer is null".to_string())).ok();
            return;
        }

        // Convert JS code to NSString
        let js_nsstring = nsstring_create(js);
        if js_nsstring.is_null() {
            tx.send(Err("Failed to create NSString from JS code".to_string())).ok();
            return;
        }

        // Completion handler: (id _Nullable result, NSError * _Nullable error) -> Void
        let block = ConcreteBlock::new(move |result: *mut Object, error: *mut Object| {
            if !error.is_null() {
                let desc: *mut Object = msg_send![error, localizedDescription];
                let err_str = nsstring_to_rust(desc)
                    .unwrap_or_else(|| "Unknown JS error".to_string());
                tx.send(Err(err_str)).ok();
                return;
            }

            if result.is_null() {
                // JS returned undefined/void
                tx.send(Ok("undefined".to_string())).ok();
                return;
            }

            // Get string representation of the result.
            // For NSString (most common — our callers return JSON.stringify output),
            // description returns the string itself.
            // For NSNumber, returns numeric representation.
            // For NSNull, returns "<null>".
            let desc: *mut Object = msg_send![result, description];
            let result_str = nsstring_to_rust(desc)
                .unwrap_or_else(|| "null".to_string());
            tx.send(Ok(result_str)).ok();
        });
        let block = block.copy();

        let _: () = msg_send![wk, evaluateJavaScript: js_nsstring
                                   completionHandler: &*block];
    }
}

/// Helper: create an NSString from a Rust &str (autoreleased).
#[cfg(target_os = "macos")]
unsafe fn nsstring_create(s: &str) -> *mut objc::runtime::Object {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let cls = class!(NSString);
    let ns: *mut Object = msg_send![cls, alloc];
    let ns: *mut Object = msg_send![ns,
        initWithBytes: s.as_ptr()
        length: s.len()
        encoding: 4usize  // NSUTF8StringEncoding
    ];
    // Autorelease so it's cleaned up after evaluateJavaScript retains it
    let ns: *mut Object = msg_send![ns, autorelease];
    ns
}

/// Helper: convert an NSString* to a Rust String (returns None for null pointers).
#[cfg(target_os = "macos")]
unsafe fn nsstring_to_rust(ns: *mut objc::runtime::Object) -> Option<String> {
    use objc::{msg_send, sel, sel_impl};

    if ns.is_null() {
        return None;
    }
    let utf8: *const i8 = msg_send![ns, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(utf8).to_string_lossy().to_string())
}
