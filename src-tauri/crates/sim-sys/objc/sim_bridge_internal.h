#ifndef SIM_BRIDGE_INTERNAL_H
#define SIM_BRIDGE_INTERNAL_H

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurface.h>
#import <ImageIO/ImageIO.h>
#import <VideoToolbox/VideoToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <malloc/malloc.h>
#import <dlfcn.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include "sim_bridge.h"

// ============================================================================
// MARK: - Function pointer typedefs (from Simulator.app disassembly)
// ============================================================================

// CORRECT function signature from Simulator.app disassembly (2026-02-04):
// IndigoHIDMessageForMouseNSEvent is loaded from Simulator.app, NOT SimulatorKit!
typedef void* (*IndigoHIDMouseFn)(
    CGPoint*,           // point1 - first touch
    CGPoint*,           // point2 - second touch (NULL for single)
    int,                // hidType - ALWAYS 0x32 (50)
    int,                // direction - 0=down, 1=up, 2=move
    CGSize              // size - {1.0, 1.0}
);

// IndigoHIDMessageForKeyboardArbitrary - for keyboard input
typedef void* (*IndigoHIDKeyboardFn)(
    uint16_t,           // keycode - HID key code (USB standard)
    int                 // direction - 0=down, 1=up
);

// IndigoHIDMessageForButton - for hardware button input (Home, Lock, etc.)
typedef void* (*IndigoHIDButtonFn)(
    int,                // keycode - button key code (0x33 for iOS)
    int,                // unknown param
    int                 // direction - 1=down, 2=up
);

// ============================================================================
// MARK: - Internal structs
// ============================================================================

// Persistent JPEG encoder (create once, reuse for all frames)
typedef struct {
    VTCompressionSessionRef session;
    int32_t width;
    int32_t height;
    float quality;
} CachedJpegEncoder;

typedef struct {
    id simDevice;               // SimDevice instance
    id screenObject;            // Screen object from IO port enumeration
    id callbackUUID;            // NSUUID used for screen callback registration
    id hidClient;               // SimDeviceLegacyHIDClient for touch injection
    dispatch_queue_t frameQueue;    // Serial queue for IOSurface callbacks + pendingSurface access
    dispatch_queue_t encodeQueue;   // Serial queue for VT JPEG encoding (one encode at a time)
    dispatch_queue_t touchQueue;    // Serial queue for touch events (thread-safe HID injection)
    dispatch_group_t pollingGroup;  // Group to track active polling loop
    FrameCallback rustCallback;
    void* rustContext;
    IOSurfaceRef currentSurface;
    double screenWidth;
    double screenHeight;
    bool polling;               // Whether we're using polling mode
    bool adapterCallbacksActive; // Whether IOSurface adapter callbacks are delivering frames
    bool frameDeliveredToRust;   // Whether at least one frame was delivered to Rust callback
    uint64_t iosurfaceFrameCount; // Counter for IOSurface callback frames (diagnostic)

    // "Latest only" encode pattern (avoids backlog when frames come faster than encoding)
    // pendingSurface: accessed ONLY from frameQueue (thread-safe via serial queue)
    // encodeInFlight: accessed ONLY from frameQueue
    IOSurfaceRef pendingSurface;    // Latest surface waiting to be encoded
    bool encodeInFlight;            // Whether an encode is currently running on encodeQueue

    // IOSurface seed for adaptive framerate — skip encoding when content hasn't changed.
    // IOSurfaceGetSeed() returns a value that increments when the surface content is
    // modified. Comparing seeds between polls eliminates 100% of redundant encodes
    // during idle screens (home screen, static apps).
    uint32_t lastSurfaceSeed;

    // Screen adapter registration (two-step approach via LegacyClient)
    id adapterCallbackUUID;     // UUID for screen adapter callback registration
    id portDescriptor;          // Port descriptor (for unregistering adapter callbacks)
    id legacyClient;            // SimDeviceLegacyClient (the actual adapter host)
    id deviceSet;               // SimDeviceSet (needed to create legacy client)

    // Persistent JPEG encoder (session created once, reused across frames)
    CachedJpegEncoder jpegEncoder;

    // Cached function pointers (loaded from Simulator.app during init)
    IndigoHIDMouseFn indigoMouseFn;
    IndigoHIDKeyboardFn indigoKeyboardFn;
    IndigoHIDButtonFn indigoButtonFn;
    bool touchInitialized;

    // Per-instance touch state (was global, moved here for multi-instance safety)
    bool touchActive;
    NSTimeInterval lastTouchTime;

    // Per-instance touch strategy (was global statics in sim_input.m, moved here
    // for multi-instance safety — each HID client may have different capabilities).
    // WARNING: g_simulatorAppHandle stays global (process-wide Simulator.app dlopen).
    int touchStrategy;              // -1=undetermined, 0=clientMethod, 1=indigoBuffer
    SEL touchMsgSel;                // Cached selector for client method touch
    SEL sendSel;                    // Cached selector for sendWithMessage:
    bool indigoVerified;            // Whether IndigoHID function verification passed
} SimBridge;

// ============================================================================
// MARK: - Internal function declarations (cross-module)
// ============================================================================

// sim_framework.m
NSString* get_xcode_developer_path(void);
bool load_frameworks(char* error_buf, int error_buf_len);

// sim_encoding.m
NSData* iosurface_to_jpeg(IOSurfaceRef surface, float quality);
NSData* bridge_encode_jpeg(SimBridge *bridge, IOSurfaceRef surface, float quality);
NSData* capture_simctl_screenshot(NSString *udid);

// sim_screen.m
void start_frame_polling(SimBridge *bridge);
void stop_frame_polling(SimBridge *bridge);
void schedule_encode(SimBridge *bridge);
IOSurfaceRef try_get_surface_from_screen(id screenObject);
id find_sim_device(const char* udid_str, id *out_device_set, char* error_buf, int error_buf_len);
bool setup_screen_capture(SimBridge *bridge, char* error_buf, int error_buf_len);
bool setup_hid_client(SimBridge *bridge, char* error_buf, int error_buf_len);

// sim_input.m
void init_touch_system(SimBridge *bridge);
bool send_touch_event(SimBridge *bridge, double x, double y, int phase);
bool send_scroll_event(SimBridge *bridge, double x, double y, double dx, double dy);
bool send_key_event(SimBridge *bridge, uint16_t keycode, int direction);
bool send_button_event(SimBridge *bridge, int button_type, int direction);

#endif /* SIM_BRIDGE_INTERNAL_H */
