#![allow(unexpected_cfgs)]

use std::sync::Mutex;

#[cfg(target_os = "macos")]
use std::sync::Once;

// ─── Window Level Constants ──────────────────────────────────────────────────
// macOS window levels from CGWindowLevelKey.
// Overlay sits above normal windows; main window above the overlay.
#[cfg(target_os = "macos")]
const LEVEL_FLOATING: i64 = 3;       // kCGFloatingWindowLevel — above all normal windows
#[cfg(target_os = "macos")]
const LEVEL_MODAL_PANEL: i64 = 8;    // kCGModalPanelWindowLevel — above floating

// NSPanel styleMask: nonActivatingPanel = 1 << 7.
// Clicking the overlay won't activate our app — focus stays on the card.
#[cfg(target_os = "macos")]
const STYLE_MASK_NON_ACTIVATING: u64 = 128;

// NSBackingStoreBuffered
#[cfg(target_os = "macos")]
const BACKING_BUFFERED: u64 = 2;

// NSCollectionBehavior: visible on all Spaces, works alongside fullscreen apps.
// canJoinAllSpaces (1) | managed (4) | participatesInCycle (32) | fullScreenAuxiliary (256)
#[cfg(target_os = "macos")]
const COLLECTION_BEHAVIOR: u64 = 1 | 4 | 32 | 256;

// Overshoot margin in points — extends the window past each screen edge to push
// macOS Sequoia's WindowServer-applied rounded corners off the visible area.
#[cfg(target_os = "macos")]
const SCREEN_OVERSHOOT: f64 = 20.0;

// Default macOS corner radius for titled windows
#[cfg(target_os = "macos")]
const DEFAULT_CORNER_RADIUS: f64 = 10.0;

// --- macOS native types for direct NSWindow frame manipulation ---
#[cfg(target_os = "macos")]
mod macos_types {
    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct NSPoint {
        pub x: f64,
        pub y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct NSSize {
        pub width: f64,
        pub height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct NSRect {
        pub origin: NSPoint,
        pub size: NSSize,
    }

    unsafe impl objc::Encode for NSPoint {
        fn encode() -> objc::Encoding {
            unsafe { objc::Encoding::from_str("{CGPoint=dd}") }
        }
    }

    unsafe impl objc::Encode for NSSize {
        fn encode() -> objc::Encoding {
            unsafe { objc::Encoding::from_str("{CGSize=dd}") }
        }
    }

    unsafe impl objc::Encode for NSRect {
        fn encode() -> objc::Encoding {
            unsafe { objc::Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
        }
    }
}

/// Saved window frame before entering onboarding — restored on exit.
#[cfg(target_os = "macos")]
static SAVED_FRAME: Mutex<Option<macos_types::NSRect>> = Mutex::new(None);

/// Saved original window class pointer — restored on exit.
/// We store the raw class pointer as usize since *const is not Send.
#[cfg(target_os = "macos")]
static SAVED_CLASS: Mutex<Option<usize>> = Mutex::new(None);

/// Saved original window level — restored on exit.
#[cfg(target_os = "macos")]
static SAVED_LEVEL: Mutex<Option<i64>> = Mutex::new(None);

/// Overlay panel pointer — the invisible click-capture NSPanel (Arc's OverlayWindow pattern).
/// Stored as usize since raw pointers aren't Send.
#[cfg(target_os = "macos")]
static OVERLAY_PANEL: Mutex<Option<usize>> = Mutex::new(None);

/// One-time registration of our unconstrained NSWindow subclass.
/// Arc's `UnconstrainedNSWindow` overrides `constrainFrameRect:toScreen:`
/// to return the proposed rect unchanged, bypassing macOS's automatic
/// window constraints (rounded corners, dock avoidance, visible area limits).
#[cfg(target_os = "macos")]
static REGISTER_UNCONSTRAINED: Once = Once::new();

/// The unconstrained subclass name — registered once, reused across calls.
#[cfg(target_os = "macos")]
const UNCONSTRAINED_CLASS_NAME: &str = "_UnconstrainedOnboarding";

/// Create and register the unconstrained NSWindow subclass at runtime.
/// This overrides `constrainFrameRect:toScreen:` to return the input unchanged,
/// exactly like Arc's `UnconstrainedNSWindow`.
#[cfg(target_os = "macos")]
fn ensure_unconstrained_class() {
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};

    REGISTER_UNCONSTRAINED.call_once(|| {
        let superclass = Class::get("NSWindow").expect("NSWindow class not found");
        let mut decl = ClassDecl::new(UNCONSTRAINED_CLASS_NAME, superclass)
            .expect("Failed to create unconstrained subclass");

        // Override constrainFrameRect:toScreen: — return proposed rect unchanged.
        // This is the PRIMARY technique Arc uses to bypass macOS window constraints.
        extern "C" fn unconstrained_constrain_frame(
            _this: &Object,
            _sel: Sel,
            proposed: macos_types::NSRect,
            _screen: *mut Object,
        ) -> macos_types::NSRect {
            proposed
        }

        // Override _shouldRoundCornersForSurface — return false to prevent
        // macOS from applying surface-level corner rounding. Without this,
        // NSThemeFrame.shapeWindow re-reads _getCachedWindowCornerRadius
        // after every setFrame:display: call and re-applies system rounding.
        extern "C" fn should_not_round_corners(
            _this: &Object,
            _sel: Sel,
        ) -> bool {
            false
        }

        unsafe {
            let sel = Sel::register("constrainFrameRect:toScreen:");
            decl.add_method(
                sel,
                unconstrained_constrain_frame
                    as extern "C" fn(&Object, Sel, macos_types::NSRect, *mut Object) -> macos_types::NSRect,
            );

            let sel2 = Sel::register("_shouldRoundCornersForSurface");
            decl.add_method(
                sel2,
                should_not_round_corners as extern "C" fn(&Object, Sel) -> bool,
            );
        }

        decl.register();
        println!("[ONBOARDING] Registered {} subclass", UNCONSTRAINED_CLASS_NAME);
    });
}

/// Swap a window's isa pointer to a different class at runtime.
/// This is equivalent to `object_setClass()` from the ObjC runtime.
#[cfg(target_os = "macos")]
unsafe fn swap_window_class(
    window: *mut objc::runtime::Object,
    class_name: &str,
) -> Result<*const objc::runtime::Class, String> {
    use objc::runtime::Class;

    extern "C" {
        fn object_setClass(
            obj: *mut objc::runtime::Object,
            cls: *const Class,
        ) -> *const Class;
    }

    let new_class = Class::get(class_name)
        .ok_or_else(|| format!("Class '{}' not found", class_name))?;
    let old_class = object_setClass(window, new_class);
    Ok(old_class)
}

/// Get the first NSWindow from NSApplication.windows.
#[cfg(target_os = "macos")]
unsafe fn get_ns_window() -> Result<*mut objc::runtime::Object, String> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
    let windows: *mut Object = msg_send![ns_app, windows];
    let count: usize = msg_send![windows, count];

    if count == 0 {
        return Err("No windows found".to_string());
    }

    let ns_window: *mut Object = msg_send![windows, objectAtIndex: 0_usize];
    if ns_window.is_null() {
        return Err("Window at index 0 is null".to_string());
    }

    Ok(ns_window)
}

/// Recursively find WKWebView and set drawsBackground = false.
#[cfg(target_os = "macos")]
unsafe fn disable_webview_background(view: *mut objc::runtime::Object) -> bool {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};

    if view.is_null() {
        return false;
    }

    if let Some(wk_class) = Class::get("WKWebView") {
        let is_wk: bool = msg_send![view, isKindOfClass: wk_class];
        if is_wk {
            let no: *mut Object = msg_send![objc::class!(NSNumber), numberWithBool: false];
            let key_cstr = std::ffi::CString::new("drawsBackground").unwrap();
            let key: *mut Object = msg_send![
                objc::class!(NSString),
                stringWithUTF8String: key_cstr.as_ptr()
            ];
            let _: () = msg_send![view, setValue: no forKey: key];
            println!("[ONBOARDING] WKWebView.drawsBackground = false");
            return true;
        }
    }

    let subviews: *mut Object = msg_send![view, subviews];
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let subview: *mut Object = msg_send![subviews, objectAtIndex: i as usize];
        if disable_webview_background(subview) {
            return true;
        }
    }

    false
}

/// Recursively find WKWebView and set drawsBackground = true (restore after onboarding).
#[cfg(target_os = "macos")]
unsafe fn restore_webview_background(view: *mut objc::runtime::Object) -> bool {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};

    if view.is_null() {
        return false;
    }

    if let Some(wk_class) = Class::get("WKWebView") {
        let is_wk: bool = msg_send![view, isKindOfClass: wk_class];
        if is_wk {
            let yes: *mut Object = msg_send![objc::class!(NSNumber), numberWithBool: true];
            let key_cstr = std::ffi::CString::new("drawsBackground").unwrap();
            let key: *mut Object = msg_send![
                objc::class!(NSString),
                stringWithUTF8String: key_cstr.as_ptr()
            ];
            let _: () = msg_send![view, setValue: yes forKey: key];
            println!("[ONBOARDING] WKWebView.drawsBackground = true (restored)");
            return true;
        }
    }

    let subviews: *mut Object = msg_send![view, subviews];
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let subview: *mut Object = msg_send![subviews, objectAtIndex: i as usize];
        if restore_webview_background(subview) {
            return true;
        }
    }

    false
}

/// Recursively hide/show ALL NSVisualEffectView instances in a view hierarchy.
///
/// Tauri's windowEffects (e.g. "underWindowBackground") insert NSVisualEffectView(s)
/// that provide vibrancy/blur material. This material is NOT transparent — it blocks
/// true see-through to the desktop. We hide them during onboarding and restore after.
#[cfg(target_os = "macos")]
unsafe fn set_visual_effect_views_hidden(view: *mut objc::runtime::Object, hidden: bool) {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};

    if view.is_null() {
        return;
    }

    if let Some(ve_class) = Class::get("NSVisualEffectView") {
        let is_ve: bool = msg_send![view, isKindOfClass: ve_class];
        if is_ve {
            let _: () = msg_send![view, setHidden: hidden];
            println!(
                "[ONBOARDING] NSVisualEffectView hidden={}",
                hidden
            );
            // Don't return — search for more instances
        }
    }

    let subviews: *mut Object = msg_send![view, subviews];
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let subview: *mut Object = msg_send![subviews, objectAtIndex: i as usize];
        set_visual_effect_views_hidden(subview, hidden);
    }
}

/// Create the overlay NSPanel — Arc's OverlayWindow pattern.
///
/// This is an invisible click-capture panel that floats above all normal windows,
/// preventing the user from interacting with the desktop during onboarding.
/// The panel is:
///   - NSPanel with nonActivatingPanel styleMask (won't steal focus from card)
///   - Floating level (above normal windows)
///   - Clear background (visually invisible — the scrim is rendered by web content)
///   - Captures clicks (ignoresMouseEvents = false)
///   - Persists when app deactivates (hidesOnDeactivate = false)
///   - Follows user across Spaces (canJoinAllSpaces)
#[cfg(target_os = "macos")]
unsafe fn create_overlay_panel(screen_frame: macos_types::NSRect) {
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};

    let panel_class = Class::get("NSPanel").expect("NSPanel class not found");
    let panel: *mut Object = msg_send![panel_class, alloc];

    let style_mask: u64 = STYLE_MASK_NON_ACTIVATING;
    let backing: u64 = BACKING_BUFFERED;

    let panel: *mut Object = msg_send![panel,
        initWithContentRect: screen_frame
        styleMask: style_mask
        backing: backing
        defer: false
    ];

    if panel.is_null() {
        println!("[ONBOARDING] WARNING: Failed to create overlay panel");
        return;
    }

    // Transparent — visually invisible. The web content renders the dark scrim.
    let _: () = msg_send![panel, setOpaque: false];
    let clear: *mut Object = msg_send![class!(NSColor), clearColor];
    let _: () = msg_send![panel, setBackgroundColor: clear];
    let _: () = msg_send![panel, setHasShadow: false];

    // Floating — above all normal windows
    let _: () = msg_send![panel, setFloatingPanel: true];
    let _: () = msg_send![panel, setLevel: LEVEL_FLOATING];

    // Persist when app loses focus — overlay stays visible after Cmd+Tab.
    let _: () = msg_send![panel, setHidesOnDeactivate: false];

    // Capture clicks — prevents clicking through to desktop apps.
    let _: () = msg_send![panel, setIgnoresMouseEvents: false];
    let _: () = msg_send![panel, setAcceptsMouseMovedEvents: true];

    let behavior: u64 = COLLECTION_BEHAVIOR;
    let _: () = msg_send![panel, setCollectionBehavior: behavior];

    // Cover full screen
    let _: () = msg_send![panel, setFrame: screen_frame display: true];

    // Order front (will be behind our main window which has a higher level)
    let _: () = msg_send![panel, orderFront: std::ptr::null::<Object>()];

    // Store reference for cleanup
    *OVERLAY_PANEL.lock().unwrap() = Some(panel as usize);
    println!("[ONBOARDING] Created overlay panel (floating, click-capture)");
}

/// Close and release the overlay panel.
#[cfg(target_os = "macos")]
unsafe fn close_overlay_panel() {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};

    let panel_ptr = OVERLAY_PANEL.lock().unwrap().take();
    if let Some(ptr) = panel_ptr {
        let panel = ptr as *mut Object;
        let _: () = msg_send![panel, orderOut: std::ptr::null::<Object>()];
        let _: () = msg_send![panel, close];
        println!("[ONBOARDING] Closed overlay panel");
    }
}

/// Enter onboarding mode: overlay panel + transparent fullscreen main window.
///
/// Two-window architecture (Arc's pattern):
///   1. Overlay panel (NSPanel, floating) — invisible click-capture layer
///   2. Main window (Tauri, modal panel level) — renders scrim + orb + card via web content
///
/// CRITICAL: We do NOT change styleMask (tao crashes in draw_rect).
/// Instead: hide traffic lights + hide NSVisualEffectView + transparency + fullscreen.
#[tauri::command]
pub fn enter_onboarding_mode(_app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("[ONBOARDING] enter_onboarding_mode");

    #[cfg(target_os = "macos")]
    {
        use macos_types::{NSPoint, NSRect, NSSize};
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};

        unsafe {
            let ns_window = get_ns_window()?;

            // Save current frame for restoration
            {
                let mut lock = SAVED_FRAME.lock().unwrap();
                if lock.is_none() {
                    let frame: NSRect = msg_send![ns_window, frame];
                    println!(
                        "[ONBOARDING] Saved frame: ({:.0},{:.0} {:.0}x{:.0})",
                        frame.origin.x, frame.origin.y,
                        frame.size.width, frame.size.height
                    );
                    *lock = Some(frame);
                }
            }

            // Save current window level for restoration
            {
                let mut lock = SAVED_LEVEL.lock().unwrap();
                if lock.is_none() {
                    let level: i64 = msg_send![ns_window, level];
                    *lock = Some(level);
                    println!("[ONBOARDING] Saved window level: {}", level);
                }
            }

            // Transparency
            let _: () = msg_send![ns_window, setOpaque: false];
            let _: () = msg_send![ns_window, setHasShadow: false];
            let clear_color: *mut Object = msg_send![class!(NSColor), clearColor];
            let _: () = msg_send![ns_window, setBackgroundColor: clear_color];

            // Hide traffic light buttons
            for button_type in 0_u64..=2 {
                let button: *mut Object = msg_send![ns_window, standardWindowButton: button_type];
                if !button.is_null() {
                    let _: () = msg_send![button, setHidden: true];
                }
            }

            // Hide ALL NSVisualEffectView instances — they block true transparency.
            let content_view: *mut Object = msg_send![ns_window, contentView];
            if !content_view.is_null() {
                let superview: *mut Object = msg_send![content_view, superview];
                let search_root = if !superview.is_null() { superview } else { content_view };
                set_visual_effect_views_hidden(search_root, true);

                // Also disable WKWebView drawsBackground
                disable_webview_background(content_view);
            }

            // Swap to unconstrained subclass — bypasses macOS window constraints.
            ensure_unconstrained_class();
            {
                let mut lock = SAVED_CLASS.lock().unwrap();
                if lock.is_none() {
                    match swap_window_class(ns_window, UNCONSTRAINED_CLASS_NAME) {
                        Ok(old_class) => {
                            *lock = Some(old_class as usize);
                            println!("[ONBOARDING] Swapped to unconstrained class");
                        }
                        Err(e) => {
                            println!("[ONBOARDING] WARNING: class swap failed: {}", e);
                        }
                    }
                }
            }

            // Get screen frame for both overlay and main window
            let screen: *mut Object = msg_send![ns_window, screen];
            let base_frame: NSRect = if !screen.is_null() {
                msg_send![screen, frame]
            } else {
                let main_screen: *mut Object = msg_send![class!(NSScreen), mainScreen];
                if !main_screen.is_null() {
                    msg_send![main_screen, frame]
                } else {
                    return Err("No screens available".to_string());
                }
            };

            // Create the overlay panel FIRST — invisible click-capture layer.
            // Uses the exact screen frame (no overshoot needed — it's invisible).
            create_overlay_panel(base_frame);

            // Main window: full screen + overshoot margin to push rounded corners off-screen.
            // On Sequoia+, the compositor applies corner rounding at the Metal level
            // that can't be overridden from userspace.
            let overshoot = SCREEN_OVERSHOOT;
            let screen_frame = NSRect {
                origin: NSPoint {
                    x: base_frame.origin.x - overshoot,
                    y: base_frame.origin.y - overshoot,
                },
                size: NSSize {
                    width: base_frame.size.width + overshoot * 2.0,
                    height: base_frame.size.height + overshoot * 2.0,
                },
            };
            println!(
                "[ONBOARDING] screen frame (with overshoot): ({:.0},{:.0} {:.0}x{:.0})",
                screen_frame.origin.x, screen_frame.origin.y,
                screen_frame.size.width, screen_frame.size.height
            );
            let _: () = msg_send![ns_window, setFrame: screen_frame display: true];

            // Elevate main window ABOVE the overlay panel.
            // Overlay is at LEVEL_FLOATING, main window at LEVEL_MODAL_PANEL.
            // This ensures the card/content is always above the click-capture layer.
            let _: () = msg_send![ns_window, setLevel: LEVEL_MODAL_PANEL];

            // Remove macOS window corner rounding AFTER setFrame:display:.
            let _: () = msg_send![ns_window, _setCornerRadius: 0.0_f64];
            let _: () = msg_send![ns_window, _setEffectiveCornerRadius: 0.0_f64];

            // Also zero the NSThemeFrame's layer corner radius directly
            let content_view2: *mut Object = msg_send![ns_window, contentView];
            if !content_view2.is_null() {
                let theme_frame: *mut Object = msg_send![content_view2, superview];
                if !theme_frame.is_null() {
                    let has_layer: bool = msg_send![theme_frame, wantsLayer];
                    if has_layer {
                        let layer: *mut Object = msg_send![theme_frame, layer];
                        if !layer.is_null() {
                            let _: () = msg_send![layer, setCornerRadius: 0.0_f64];
                        }
                    }
                }
            }
            println!("[ONBOARDING] Corner radius zeroed (after frame set)");

            // Show the window
            let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            println!("[ONBOARDING] Window configured and shown (two-window mode)");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        if let Some(win) = _app_handle.get_webview_window("main") {
            win.show().map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Exit onboarding mode: close overlay, restore everything.
///
/// CRITICAL: The window is hidden (orderOut) FIRST, then all state is restored
/// invisibly. The caller is responsible for showing the window again:
///   - StrictMode remount: `enter_onboarding_mode` → `makeKeyAndOrderFront`
///   - Real exit: `show_main_window` → `makeKeyAndOrderFront`
///
/// This prevents two visible flashes:
///   1. StrictMode exit→re-enter: user would see the window briefly revert to
///      normal (opaque, small) before re-entering onboarding mode.
///   2. Real exit: user would see the window animate from fullscreen to normal
///      while web content is empty (overlay already faded out via CSS).
#[tauri::command]
pub fn exit_onboarding_mode(_app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("[ONBOARDING] exit_onboarding_mode");

    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};

        unsafe {
            // Close the overlay panel first
            close_overlay_panel();

            if let Ok(ns_window) = get_ns_window() {
                // ── HIDE WINDOW FIRST ──────────────────────────────────
                // All state changes below happen while the window is off-screen.
                // No flash, no animation visible to the user.
                let _: () = msg_send![ns_window, orderOut: std::ptr::null::<Object>()];
                println!("[ONBOARDING] Window hidden for state restoration");

                // Restore original window class
                {
                    let saved_class = SAVED_CLASS.lock().unwrap().take();
                    if let Some(class_ptr) = saved_class {
                        extern "C" {
                            fn object_setClass(
                                obj: *mut objc::runtime::Object,
                                cls: *const objc::runtime::Class,
                            ) -> *const objc::runtime::Class;
                        }
                        object_setClass(
                            ns_window,
                            class_ptr as *const objc::runtime::Class,
                        );
                        println!("[ONBOARDING] Restored original window class");
                    }
                }

                // Restore window level
                {
                    let saved_level = SAVED_LEVEL.lock().unwrap().take();
                    if let Some(level) = saved_level {
                        let _: () = msg_send![ns_window, setLevel: level];
                        println!("[ONBOARDING] Restored window level: {}", level);
                    }
                }

                // Restore window opacity
                let _: () = msg_send![ns_window, setOpaque: true];
                let bg_color: *mut Object =
                    msg_send![objc::class!(NSColor), windowBackgroundColor];
                let _: () = msg_send![ns_window, setBackgroundColor: bg_color];

                // Restore corner radius to macOS default
                let _: () = msg_send![ns_window, _setCornerRadius: DEFAULT_CORNER_RADIUS];

                // Restore shadow
                let _: () = msg_send![ns_window, setHasShadow: true];

                // Show traffic light buttons
                for button_type in 0_u64..=2 {
                    let button: *mut Object =
                        msg_send![ns_window, standardWindowButton: button_type];
                    if !button.is_null() {
                        let _: () = msg_send![button, setHidden: false];
                    }
                }

                // Restore NSVisualEffectView instances for vibrancy
                let content_view: *mut Object = msg_send![ns_window, contentView];
                if !content_view.is_null() {
                    let superview: *mut Object = msg_send![content_view, superview];
                    let search_root =
                        if !superview.is_null() { superview } else { content_view };
                    set_visual_effect_views_hidden(search_root, false);

                    // Restore WKWebView drawsBackground
                    restore_webview_background(content_view);
                }

                // Restore saved frame WITHOUT animation — window is hidden anyway.
                let saved = SAVED_FRAME.lock().unwrap().take();
                if let Some(frame) = saved {
                    let _: () =
                        msg_send![ns_window, setFrame: frame display: true animate: false];
                    println!("[ONBOARDING] Restored window frame (hidden)");
                }

                // Window stays hidden — caller will show it:
                //   - enter_onboarding_mode → makeKeyAndOrderFront (StrictMode)
                //   - show_main_window → makeKeyAndOrderFront (real exit)
            }
        }
    }

    Ok(())
}

/// Show the main window normally (for returning users who skip onboarding).
#[tauri::command]
pub fn show_main_window(_app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("[ONBOARDING] show_main_window (no onboarding)");

    #[cfg(target_os = "macos")]
    {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};

        unsafe {
            if let Ok(ns_window) = get_ns_window() {
                let _: () = msg_send![ns_window, setHasShadow: true];
                let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::Manager;
        if let Some(win) = _app_handle.get_webview_window("main") {
            win.show().map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[derive(serde::Serialize)]
pub struct CliCheckResult {
    pub installed: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub fn check_cli_tool(name: String) -> Result<CliCheckResult, String> {
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid tool name".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    let output = std::process::Command::new("which")
        .arg(&name)
        .output()
        .map_err(|e| format!("Failed to run which: {}", e))?;

    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("where")
        .arg(&name)
        .output()
        .map_err(|e| format!("Failed to run where: {}", e))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(CliCheckResult {
            installed: true,
            path: Some(path),
        })
    } else {
        Ok(CliCheckResult {
            installed: false,
            path: None,
        })
    }
}

#[derive(serde::Serialize)]
pub struct GhAuthResult {
    pub authenticated: bool,
    pub username: Option<String>,
}

#[tauri::command]
pub fn check_gh_auth() -> Result<GhAuthResult, String> {
    let output = std::process::Command::new("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .output()
        .map_err(|e| format!("Failed to run gh auth status: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{}{}", stdout, stderr);

    if combined.contains("Logged in to") {
        let username = combined
            .lines()
            .find(|l| l.contains("account"))
            .and_then(|l| {
                l.split("account ")
                    .nth(1)
                    .map(|s| s.split_whitespace().next().unwrap_or("").to_string())
            });
        Ok(GhAuthResult {
            authenticated: true,
            username,
        })
    } else {
        Ok(GhAuthResult {
            authenticated: false,
            username: None,
        })
    }
}
