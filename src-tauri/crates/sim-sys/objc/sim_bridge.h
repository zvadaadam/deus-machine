#ifndef SIM_BRIDGE_H
#define SIM_BRIDGE_H

#include <stdint.h>
#include <stdbool.h>

/// Opaque handle to the simulator bridge
typedef void* SimBridgeHandle;

/// Frame callback: called when a new JPEG frame is ready.
/// Parameters: context (user data), jpeg_data pointer, jpeg_data length
typedef void (*FrameCallback)(void* context, const uint8_t* jpeg_data, uint64_t jpeg_length);

/// Create a bridge to a booted simulator identified by UDID.
/// Returns NULL on failure; writes error message to error_buf.
SimBridgeHandle sim_bridge_create(const char* udid, char* error_buf, int error_buf_len);

/// Register a callback that fires on each new screen frame.
/// The callback is invoked on an internal dispatch queue with JPEG-encoded frame data.
bool sim_bridge_register_frame_callback(SimBridgeHandle handle,
                                        FrameCallback callback,
                                        void* context);

/// Stop frame callbacks and release all resources.
void sim_bridge_destroy(SimBridgeHandle handle);

/// Inject a touch event into the simulator.
/// x, y: normalized coordinates [0.0, 1.0]
/// phase: 0=began, 1=moved, 2=ended
bool sim_bridge_send_touch(SimBridgeHandle handle,
                           double x, double y, int phase);

/// Inject a scroll/wheel event into the simulator.
/// x, y: normalized coordinates [0.0, 1.0] where scroll occurs
/// dx: horizontal scroll delta (positive = right)
/// dy: vertical scroll delta (positive = down)
bool sim_bridge_send_scroll(SimBridgeHandle handle,
                            double x, double y, double dx, double dy);

/// Inject a keyboard event into the simulator.
/// keycode: HID key code (USB standard)
/// direction: 0=key down, 1=key up
bool sim_bridge_send_key(SimBridgeHandle handle,
                         uint16_t keycode, int direction);

/// Inject a hardware button event into the simulator.
/// button_type: 0=Home (only supported value)
/// direction: 0=button down, 1=button up
bool sim_bridge_send_button(SimBridgeHandle handle,
                            int button_type, int direction);

/// Get the screen dimensions (in points) of the connected simulator.
bool sim_bridge_get_screen_size(SimBridgeHandle handle,
                                double* out_width, double* out_height);

/// Take a screenshot and return JPEG data.
/// Returns the length of the JPEG data written to out_buffer.
/// If out_buffer is NULL, returns the required buffer size.
/// Returns 0 on failure.
uint64_t sim_bridge_screenshot(SimBridgeHandle handle,
                               uint8_t* out_buffer, uint64_t buffer_size);

/// Press the Home button using keyboard shortcut (Cmd+Shift+H to Simulator.app)
bool sim_bridge_press_home(SimBridgeHandle handle);

/// Check whether HID client was initialized successfully.
/// If false, touch/scroll/key/button injection will not work.
bool sim_bridge_is_hid_available(SimBridgeHandle handle);

#endif /* SIM_BRIDGE_H */
