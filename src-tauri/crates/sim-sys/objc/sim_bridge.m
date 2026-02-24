#import "sim_bridge_internal.h"

// ============================================================================
// MARK: - Public C API
// ============================================================================

SimBridgeHandle sim_bridge_create(const char* udid, char* error_buf, int error_buf_len) {
    @autoreleasepool {
        if (!load_frameworks(error_buf, error_buf_len)) {
            return NULL;
        }

        SimBridge *bridge = (SimBridge *)calloc(1, sizeof(SimBridge));
        if (!bridge) {
            snprintf(error_buf, error_buf_len, "Failed to allocate SimBridge");
            return NULL;
        }
        bridge->touchStrategy = -1; // undetermined (calloc zeros to 0 which means "clientMethod")

        // Find the simulator device (also retrieves the device set for legacy client)
        id deviceSet = nil;
        id device = find_sim_device(udid, &deviceSet, error_buf, error_buf_len);
        if (!device) {
            free(bridge);
            return NULL;
        }
        bridge->simDevice = device;
        bridge->deviceSet = deviceSet;

        // Check device is booted
        SEL stateSel = NSSelectorFromString(@"state");
        if (stateSel && [device respondsToSelector:stateSel]) {
            NSInteger state = ((NSInteger (*)(id, SEL))objc_msgSend)(device, stateSel);
            // State 3 = Booted
            if (state != 3) {
                snprintf(error_buf, error_buf_len,
                         "Simulator is not booted (state=%ld). Boot it first.", (long)state);
                free(bridge);
                return NULL;
            }
        }

        NSLog(@"[SimBridge] Connected to simulator: %s", udid);

        // Set up screen capture
        if (!setup_screen_capture(bridge, error_buf, error_buf_len)) {
            free(bridge);
            return NULL;
        }

        // Set up HID client for touch injection (optional, non-fatal if fails)
        setup_hid_client(bridge, error_buf, error_buf_len);

        return (SimBridgeHandle)bridge;
    }
}

bool sim_bridge_register_frame_callback(SimBridgeHandle handle,
                                        FrameCallback callback,
                                        void* context) {
    if (!handle) return false;
    SimBridge *bridge = (SimBridge *)handle;
    bridge->rustCallback = callback;
    bridge->rustContext = context;
    bridge->frameDeliveredToRust = false;

    NSLog(@"[SimBridge] Registering frame callback, currentSurface=%p, screenObject=%@, adapterCallbacksActive=%d",
          bridge->currentSurface, bridge->screenObject ? [bridge->screenObject class] : @"nil",
          bridge->adapterCallbacksActive);

    // If IOSurface adapter callbacks are already delivering frames, trust them
    // but start a watchdog to auto-fallback if they silently stop.
    if (bridge->adapterCallbacksActive) {
        NSLog(@"[SimBridge] IOSurface adapter callbacks active — starting watchdog timer");

        // SAFETY: Dispatch the watchdog on frameQueue (NOT the global queue).
        // frameQueue is drained during sim_bridge_destroy, so the block will either
        // execute before destroy (sees rustCallback != NULL, does its work) or be
        // drained during destroy (sees rustCallback == NULL, bails out).
        // Using the global queue would be a use-after-free: the block captures a raw
        // SimBridge* that could be freed before the 2-second timer fires.
        SimBridge *capturedBridge = bridge;
        dispatch_after(
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)),
            bridge->frameQueue,
            ^{
                if (!capturedBridge->rustCallback) return; // Bridge destroyed
                if (capturedBridge->frameDeliveredToRust) {
                    NSLog(@"[SimBridge] Watchdog: frames flowing — IOSurface path healthy");
                    return;
                }
                NSLog(@"[SimBridge] Watchdog: NO frames after 2s — IOSurface callbacks may have failed, starting polling fallback");
                if (!capturedBridge->polling) {
                    start_frame_polling(capturedBridge);
                }
            }
        );
        return true;
    }

    // If no surface yet, try to fetch it directly
    if (!bridge->currentSurface && bridge->screenObject) {
        IOSurfaceRef surface = try_get_surface_from_screen(bridge->screenObject);
        if (surface) {
            bridge->currentSurface = (IOSurfaceRef)CFRetain(surface);
            bridge->screenWidth = (double)IOSurfaceGetWidth(surface);
            bridge->screenHeight = (double)IOSurfaceGetHeight(surface);
            NSLog(@"[SimBridge] Fetched IOSurface directly: %zux%zu",
                  IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface));
        }
    }

    // Only start polling as fallback when not already polling
    if (!bridge->polling) {
        NSLog(@"[SimBridge] No IOSurface callbacks — starting simctl polling fallback");
        start_frame_polling(bridge);
    }

    return true;
}

void sim_bridge_destroy(SimBridgeHandle handle) {
    if (!handle) return;
    SimBridge *bridge = (SimBridge *)handle;

    @autoreleasepool {
        NSLog(@"[SimBridge] Destroying bridge — beginning teardown");

        // Step 1: Prevent further Rust callbacks immediately.
        // In-flight blocks may still read this, but will see NULL and bail out.
        bridge->rustCallback = NULL;
        bridge->rustContext = NULL;

        // Step 2: Stop frame polling timer.
        // dispatch_source_cancel prevents NEW handler invocations but does NOT
        // wait for an already-executing handler to finish.
        stop_frame_polling(bridge);

        // Step 3: Unregister screen adapter callbacks (Radon two-step approach).
        // This tells SimulatorKit to stop enqueuing new frame callbacks.
        // Try legacyClient first (Radon pattern), then portDescriptor (fallback)
        id adapterHost = bridge->legacyClient ?: bridge->portDescriptor;
        if (adapterHost && bridge->adapterCallbackUUID) {
            SEL unregAdapterSel = NSSelectorFromString(
                @"unregisterScreenAdapterCallbacksWithUUID:");
            if (unregAdapterSel && [adapterHost respondsToSelector:unregAdapterSel]) {
                ((void (*)(id, SEL, id))objc_msgSend)(
                    adapterHost, unregAdapterSel, bridge->adapterCallbackUUID
                );
                NSLog(@"[SimBridge] Unregistered screen adapter callbacks");
            }
        }

        // Unregister screen frame callbacks via UUID
        if (bridge->screenObject && bridge->callbackUUID) {
            SEL unregSel = NSSelectorFromString(
                @"unregisterScreenCallbacksWithUUID:");
            if (unregSel && [bridge->screenObject respondsToSelector:unregSel]) {
                ((void (*)(id, SEL, id))objc_msgSend)(
                    bridge->screenObject, unregSel, bridge->callbackUUID
                );
                NSLog(@"[SimBridge] Unregistered screen callbacks");
            }
        }

        // Step 4: Drain dispatch queues in dependency order.
        // The "latest only" encode pattern bounces between frameQueue and encodeQueue:
        //   frameQueue → encodeQueue (encode) → frameQueue (check for more)
        // So we drain: frameQueue → encodeQueue → frameQueue (again, to catch bounce-back)
        if (bridge->frameQueue) {
            dispatch_sync(bridge->frameQueue, ^{
                NSLog(@"[SimBridge] Frame queue drained (pass 1)");
            });
        }
        if (bridge->encodeQueue) {
            dispatch_barrier_sync(bridge->encodeQueue, ^{
                NSLog(@"[SimBridge] Encode queue drained");
            });
        }
        // Second drain of frameQueue catches any bounce-back from encode completion
        if (bridge->frameQueue) {
            dispatch_sync(bridge->frameQueue, ^{
                NSLog(@"[SimBridge] Frame queue drained (pass 2)");
            });
        }
        if (bridge->touchQueue) {
            dispatch_sync(bridge->touchQueue, ^{
                NSLog(@"[SimBridge] Touch queue drained");
            });
        }

        NSLog(@"[SimBridge] All dispatch queues drained — safe to free resources");

        // Step 5: Release surfaces
        if (bridge->pendingSurface) {
            CFRelease(bridge->pendingSurface);
            bridge->pendingSurface = NULL;
        }
        if (bridge->currentSurface) {
            CFRelease(bridge->currentSurface);
            bridge->currentSurface = NULL;
        }

        // Step 6: Clean up persistent JPEG encoder
        if (bridge->jpegEncoder.session) {
            VTCompressionSessionInvalidate(bridge->jpegEncoder.session);
            CFRelease(bridge->jpegEncoder.session);
            bridge->jpegEncoder.session = NULL;
            NSLog(@"[SimBridge] Destroyed persistent VTCompressionSession");
        }

        // Step 7: Clean up touch system (function pointers + per-instance strategy)
        bridge->indigoMouseFn = NULL;
        bridge->indigoKeyboardFn = NULL;
        bridge->indigoButtonFn = NULL;
        bridge->touchInitialized = false;
        bridge->touchStrategy = -1;
        bridge->touchMsgSel = NULL;
        bridge->sendSel = NULL;
        bridge->indigoVerified = false;

        bridge->callbackUUID = nil;
        bridge->adapterCallbackUUID = nil;
        bridge->portDescriptor = nil;
        bridge->legacyClient = nil;
        bridge->deviceSet = nil;
        bridge->screenObject = nil;
        bridge->hidClient = nil;
        bridge->simDevice = nil;
    }

    free(bridge);
    NSLog(@"[SimBridge] Bridge destroyed");
}

// ============================================================================
// MARK: - Public C API wrappers
// ============================================================================

bool sim_bridge_send_touch(SimBridgeHandle handle,
                           double x, double y, int phase) {
    if (!handle) return false;
    return send_touch_event((SimBridge *)handle, x, y, phase);
}

bool sim_bridge_send_scroll(SimBridgeHandle handle,
                            double x, double y, double dx, double dy) {
    if (!handle) return false;
    return send_scroll_event((SimBridge *)handle, x, y, dx, dy);
}

bool sim_bridge_send_key(SimBridgeHandle handle,
                         uint16_t keycode, int direction) {
    if (!handle) return false;
    return send_key_event((SimBridge *)handle, keycode, direction);
}

bool sim_bridge_send_button(SimBridgeHandle handle,
                            int button_type, int direction) {
    if (!handle) return false;
    return send_button_event((SimBridge *)handle, button_type, direction);
}

bool sim_bridge_get_screen_size(SimBridgeHandle handle,
                                double* out_width, double* out_height) {
    if (!handle) return false;
    SimBridge *bridge = (SimBridge *)handle;
    if (bridge->screenWidth <= 0 || bridge->screenHeight <= 0) return false;
    *out_width = bridge->screenWidth;
    *out_height = bridge->screenHeight;
    return true;
}

uint64_t sim_bridge_screenshot(SimBridgeHandle handle,
                               uint8_t* out_buffer, uint64_t buffer_size) {
    if (!handle) return 0;
    SimBridge *bridge = (SimBridge *)handle;

    @autoreleasepool {
        NSString *udid = nil;
        SEL udidSel = NSSelectorFromString(@"UDID");
        if (udidSel && [bridge->simDevice respondsToSelector:udidSel]) {
            NSUUID *udidObj = ((id (*)(id, SEL))objc_msgSend)(bridge->simDevice, udidSel);
            if (udidObj) {
                udid = [udidObj UUIDString];
            }
        }

        if (!udid) {
            NSLog(@"[SimBridge] Screenshot: Could not get device UDID");
            return 0;
        }

        NSString *tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"screenshot_%@.jpg", [[NSUUID UUID] UUIDString]]];

        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcrun"];
        task.arguments = @[@"simctl", @"io", udid, @"screenshot", @"--type=jpeg", tmpPath];
        task.standardOutput = [NSPipe pipe];
        task.standardError = [NSPipe pipe];

        NSError *error = nil;
        [task launchAndReturnError:&error];
        if (error) {
            NSLog(@"[SimBridge] Screenshot launch error: %@", error);
            return 0;
        }

        [task waitUntilExit];

        if (task.terminationStatus != 0) {
            NSLog(@"[SimBridge] Screenshot failed with status %d", task.terminationStatus);
            return 0;
        }

        NSData *jpegData = [NSData dataWithContentsOfFile:tmpPath];
        [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];

        if (!jpegData || jpegData.length == 0) {
            NSLog(@"[SimBridge] Screenshot: No data");
            return 0;
        }

        if (!out_buffer) {
            return (uint64_t)jpegData.length;
        }

        uint64_t copyLen = MIN(buffer_size, (uint64_t)jpegData.length);
        memcpy(out_buffer, jpegData.bytes, copyLen);

        NSLog(@"[SimBridge] Screenshot captured: %llu bytes", (unsigned long long)jpegData.length);
        return (uint64_t)jpegData.length;
    }
}

bool sim_bridge_is_hid_available(SimBridgeHandle handle) {
    if (!handle) return false;
    SimBridge *bridge = (SimBridge *)handle;
    return bridge->hidClient != nil;
}

bool sim_bridge_press_home(SimBridgeHandle handle) {
    if (!handle) return false;

    @autoreleasepool {
        NSString *script = @"tell application \"Simulator\" to activate\n"
                           @"delay 0.1\n"
                           @"tell application \"System Events\"\n"
                           @"    keystroke \"h\" using {command down, shift down}\n"
                           @"end tell";

        NSAppleScript *appleScript = [[NSAppleScript alloc] initWithSource:script];
        NSDictionary *errorDict = nil;
        [appleScript executeAndReturnError:&errorDict];

        if (errorDict) {
            NSLog(@"[SimBridge] Home button AppleScript error: %@", errorDict);
            return false;
        }

        NSLog(@"[SimBridge] Home button pressed via AppleScript");
        return true;
    }
}
