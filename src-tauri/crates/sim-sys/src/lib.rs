use std::ffi::{c_char, c_double, c_int, c_ushort, c_void};

pub type SimBridgeHandle = *mut c_void;
pub type FrameCallbackFn = extern "C" fn(*mut c_void, *const u8, u64);

extern "C" {
    pub fn sim_bridge_create(
        udid: *const c_char,
        error_buf: *mut c_char,
        error_buf_len: c_int,
    ) -> SimBridgeHandle;

    pub fn sim_bridge_register_frame_callback(
        handle: SimBridgeHandle,
        callback: FrameCallbackFn,
        context: *mut c_void,
    ) -> bool;

    pub fn sim_bridge_destroy(handle: SimBridgeHandle);

    pub fn sim_bridge_send_touch(
        handle: SimBridgeHandle,
        x: c_double,
        y: c_double,
        phase: c_int,
    ) -> bool;

    pub fn sim_bridge_send_scroll(
        handle: SimBridgeHandle,
        x: c_double,
        y: c_double,
        dx: c_double,
        dy: c_double,
    ) -> bool;

    pub fn sim_bridge_send_key(
        handle: SimBridgeHandle,
        keycode: c_ushort,
        direction: c_int,
    ) -> bool;

    pub fn sim_bridge_send_button(
        handle: SimBridgeHandle,
        button_type: c_int,
        direction: c_int,
    ) -> bool;

    pub fn sim_bridge_get_screen_size(
        handle: SimBridgeHandle,
        out_width: *mut c_double,
        out_height: *mut c_double,
    ) -> bool;

    pub fn sim_bridge_screenshot(
        handle: SimBridgeHandle,
        out_buffer: *mut u8,
        buffer_size: u64,
    ) -> u64;

    pub fn sim_bridge_press_home(handle: SimBridgeHandle) -> bool;

    pub fn sim_bridge_is_hid_available(handle: SimBridgeHandle) -> bool;
}
