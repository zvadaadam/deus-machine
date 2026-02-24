#import "sim_bridge_internal.h"

// ============================================================================
// MARK: - Touch system initialization
// ============================================================================

static const NSTimeInterval kMinMoveInterval = 0.016; // ~60fps max

// Touch strategy, cached selectors, and IndigoHID verification are now
// per-instance fields in SimBridge (see sim_bridge_internal.h) for
// multi-instance safety. Previously these were global statics.

/**
 * Load a symbol from Simulator.app executable.
 *
 * PRIMARY APPROACH (from Simulator.app disassembly):
 * Uses [NSBundle bundleWithIdentifier:@"com.apple.iphonesimulator"] but this
 * only works when Simulator.app is running and its bundle is registered.
 *
 * FALLBACK APPROACH:
 * We also try the direct path at $(xcode-select -p)/Applications/Simulator.app
 * which works even if Simulator.app is not running.
 */
static void* getSimulatorAppSymbol(const char* symbolName) {
    static void* g_simulatorAppHandle = NULL;
    static dispatch_once_t onceToken;

    dispatch_once(&onceToken, ^{
        // Method 1: Try bundle identifier (works when Simulator.app is running)
        NSBundle *bundle = [NSBundle bundleWithIdentifier:@"com.apple.iphonesimulator"];
        if (bundle) {
            NSString *execPath = [bundle executablePath];
            NSLog(@"[SimBridge] Loading symbols from Simulator.app (bundle): %@", execPath);
            g_simulatorAppHandle = dlopen([execPath UTF8String], RTLD_LAZY);
        }

        // Method 2: Direct path via xcode-select (works even if Simulator not running)
        if (!g_simulatorAppHandle) {
            NSString *devPath = get_xcode_developer_path();
            NSString *simPath = [devPath stringByAppendingPathComponent:
                @"Applications/Simulator.app/Contents/MacOS/Simulator"];
            NSLog(@"[SimBridge] Loading symbols from Simulator.app (path): %@", simPath);

            if ([[NSFileManager defaultManager] fileExistsAtPath:simPath]) {
                g_simulatorAppHandle = dlopen([simPath UTF8String], RTLD_LAZY);
            }
        }

        if (!g_simulatorAppHandle) {
            NSLog(@"[SimBridge] WARNING: Could not load Simulator.app - touch won't work");
            NSLog(@"[SimBridge] dlopen error: %s", dlerror());
        }
    });

    if (!g_simulatorAppHandle) return NULL;
    return dlsym(g_simulatorAppHandle, symbolName);
}

void init_touch_system(SimBridge *bridge) {
    if (bridge->touchInitialized) return;
    bridge->touchInitialized = true;

    // Create serial touch queue for thread-safe HID injection
    bridge->touchQueue = dispatch_queue_create(
        "com.hivenet.sim-bridge.touch", DISPATCH_QUEUE_SERIAL);

    // Load IndigoHID functions from Simulator.app
    bridge->indigoMouseFn = (IndigoHIDMouseFn)getSimulatorAppSymbol(
        "IndigoHIDMessageForMouseNSEvent");
    if (bridge->indigoMouseFn) {
        NSLog(@"[SimBridge] IndigoHIDMessageForMouseNSEvent loaded at %p",
              (void *)bridge->indigoMouseFn);
    } else {
        NSLog(@"[SimBridge] WARNING: IndigoHIDMessageForMouseNSEvent not found");
    }

    bridge->indigoKeyboardFn = (IndigoHIDKeyboardFn)getSimulatorAppSymbol(
        "IndigoHIDMessageForKeyboardArbitrary");
    if (bridge->indigoKeyboardFn) {
        NSLog(@"[SimBridge] IndigoHIDMessageForKeyboardArbitrary loaded");
    } else {
        NSLog(@"[SimBridge] WARNING: IndigoHIDMessageForKeyboardArbitrary not found");
    }

    bridge->indigoButtonFn = (IndigoHIDButtonFn)getSimulatorAppSymbol(
        "IndigoHIDMessageForButton");
    if (bridge->indigoButtonFn) {
        NSLog(@"[SimBridge] IndigoHIDMessageForButton loaded");
    } else {
        NSLog(@"[SimBridge] WARNING: IndigoHIDMessageForButton not found");
    }

    // ========================================================================
    // Verify IndigoHID function actually works with test parameters
    // ========================================================================
    if (bridge->indigoMouseFn) {
        @try {
            CGPoint testPt = CGPointMake(100.0, 100.0);
            void *testResult = bridge->indigoMouseFn(
                &testPt, NULL, 0x32, 1, CGSizeMake(1.0, 1.0));
            if (testResult) {
                size_t testSize = malloc_size(testResult);
                NSLog(@"[SimBridge] IndigoHID VERIFIED: test touch returned %zu bytes", testSize);
                bridge->indigoVerified = true;

                // Log first 64 bytes of the result for debugging
                uint8_t *bytes = (uint8_t *)testResult;
                NSMutableString *hex = [NSMutableString string];
                for (size_t i = 0; i < MIN(64, testSize); i++) {
                    [hex appendFormat:@"%02x", bytes[i]];
                    if ((i + 1) % 16 == 0) [hex appendString:@"\n"];
                    else if ((i + 1) % 4 == 0) [hex appendString:@" "];
                }
                NSLog(@"[SimBridge] IndigoHID test buffer (first 64 bytes):\n%@", hex);
                free(testResult);
            } else {
                NSLog(@"[SimBridge] WARNING: IndigoHID returned NULL for test touch "
                       "(may not support type 0x32 on this macOS version)");
            }
        } @catch (NSException *e) {
            NSLog(@"[SimBridge] WARNING: IndigoHID test CRASHED: %@", e);
        }
    }

    // ========================================================================
    // Probe HID client capabilities
    // ========================================================================
    if (bridge->hidClient) {
        // Log the HID client class and its full hierarchy
        Class cls = [bridge->hidClient class];
        NSLog(@"[SimBridge] HID client class: %s", class_getName(cls));

        // Log ALL instance methods (including inherited)
        while (cls) {
            unsigned int methodCount = 0;
            Method *methods = class_copyMethodList(cls, &methodCount);
            NSLog(@"[SimBridge] %s has %u methods:", class_getName(cls), methodCount);
            for (unsigned int i = 0; i < methodCount; i++) {
                SEL sel = method_getName(methods[i]);
                const char *enc = method_getTypeEncoding(methods[i]);
                NSLog(@"[SimBridge]   - %@ [%s]", NSStringFromSelector(sel), enc ?: "?");
            }
            free(methods);
            cls = class_getSuperclass(cls);
            if (cls == [NSObject class]) break; // Stop at NSObject
        }

        // Check specific selectors we care about
        bridge->sendSel = NSSelectorFromString(
            @"sendWithMessage:freeWhenDone:completionQueue:completion:");
        bridge->touchMsgSel = NSSelectorFromString(
            @"touchMessageForTouchAt:secondTouchAt:direction:");

        BOOL hasSend = bridge->sendSel && [bridge->hidClient respondsToSelector:bridge->sendSel];
        BOOL hasTouchMsg = bridge->touchMsgSel && [bridge->hidClient respondsToSelector:bridge->touchMsgSel];

        NSLog(@"[SimBridge] HID responds to sendWithMessage:freeWhenDone:completionQueue:completion: %@",
              hasSend ? @"YES" : @"NO");
        NSLog(@"[SimBridge] HID responds to touchMessageForTouchAt:secondTouchAt:direction: %@",
              hasTouchMsg ? @"YES" : @"NO");

        // Log type encoding for sendWithMessage: (detect API changes)
        if (hasSend) {
            Method m = class_getInstanceMethod([bridge->hidClient class], bridge->sendSel);
            if (m) {
                const char *enc = method_getTypeEncoding(m);
                NSLog(@"[SimBridge] sendWithMessage: type encoding = %s", enc ?: "(null)");
            }
        }

        // Log type encoding for touchMessageForTouchAt:
        if (hasTouchMsg) {
            Method m = class_getInstanceMethod([bridge->hidClient class], bridge->touchMsgSel);
            if (m) {
                const char *enc = method_getTypeEncoding(m);
                NSLog(@"[SimBridge] touchMessageForTouchAt: type encoding = %s", enc ?: "(null)");
            }

            // Test the method with sample coordinates
            @try {
                CGPoint testPt = CGPointMake(100.0, 100.0);
                CGPoint noSecond = CGPointMake(-1.0, -1.0);
                void *testMsg = ((void *(*)(id, SEL, CGPoint, CGPoint, int))objc_msgSend)(
                    bridge->hidClient, bridge->touchMsgSel, testPt, noSecond, 1);
                if (testMsg) {
                    size_t sz = malloc_size(testMsg);
                    NSLog(@"[SimBridge] touchMessageForTouchAt: test (px 100,100) returned %zu bytes", sz);
                    free(testMsg);
                } else {
                    NSLog(@"[SimBridge] touchMessageForTouchAt: test (px 100,100) returned NULL");
                }

                // Also test with normalized coordinates
                CGPoint normPt = CGPointMake(0.5, 0.5);
                void *testMsg2 = ((void *(*)(id, SEL, CGPoint, CGPoint, int))objc_msgSend)(
                    bridge->hidClient, bridge->touchMsgSel, normPt, noSecond, 1);
                if (testMsg2) {
                    size_t sz2 = malloc_size(testMsg2);
                    NSLog(@"[SimBridge] touchMessageForTouchAt: test (norm 0.5,0.5) returned %zu bytes", sz2);
                    free(testMsg2);
                } else {
                    NSLog(@"[SimBridge] touchMessageForTouchAt: test (norm 0.5,0.5) returned NULL");
                }
            } @catch (NSException *e) {
                NSLog(@"[SimBridge] touchMessageForTouchAt: test CRASHED: %@", e);
            }
        }

        // Check additional touch-related selectors
        NSArray *extraSelectors = @[
            @"sendButtonEventWithKeyCode:keyDirection:",
            @"performTouch:completion:",
            @"sendTouchEvent:",
            @"touch:atPoint:withPressure:",
        ];
        for (NSString *selStr in extraSelectors) {
            SEL sel = NSSelectorFromString(selStr);
            BOOL responds = sel && [bridge->hidClient respondsToSelector:sel];
            if (responds) {
                NSLog(@"[SimBridge] HID also responds to %@", selStr);
            }
        }
    }

    // Determine best strategy
    if (bridge->hidClient && bridge->touchMsgSel &&
        [bridge->hidClient respondsToSelector:bridge->touchMsgSel]) {
        bridge->touchStrategy = 0; // Client method (preferred — higher-level API)
        NSLog(@"[SimBridge] Touch strategy: CLIENT METHOD (touchMessageForTouchAt:)");
    } else if (bridge->indigoVerified) {
        bridge->touchStrategy = 1; // IndigoHID buffer format
        NSLog(@"[SimBridge] Touch strategy: INDIGO BUFFER (IndigoHID + 352-byte format)");
    } else {
        bridge->touchStrategy = -1; // Nothing works
        NSLog(@"[SimBridge] WARNING: No touch strategy available!");
    }
}

// ============================================================================
// MARK: - Touch injection strategies
// ============================================================================

/**
 * STRATEGY 0: High-level HID client method.
 *
 * Uses touchMessageForTouchAt:secondTouchAt:direction: which constructs
 * the correct HID message buffer internally. This is what the
 * simulator-server binary uses (confirmed via disassembly).
 *
 * IMPORTANT: Uses a SEPARATE completion queue (global queue) to avoid
 * potential deadlock — we're already on touchQueue via dispatch_sync,
 * so using touchQueue as completionQueue could deadlock if sendWithMessage:
 * dispatches completion synchronously.
 */
static bool send_via_client_method(SimBridge *bridge, CGPoint pt,
                                    int direction) {
    id client = bridge->hidClient;
    // Use a DIFFERENT queue for completion to avoid deadlocking the touch queue.
    // The completion block is nil so this is mostly for internal HID client use.
    dispatch_queue_t completionQ = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);

    __block bool success = false;
    dispatch_sync(bridge->touchQueue, ^{
        @autoreleasepool {
            @try {
                CGPoint noSecondTouch = CGPointMake(-1.0, -1.0);

                void *message = ((void *(*)(id, SEL, CGPoint, CGPoint, int))objc_msgSend)(
                    client, bridge->touchMsgSel, pt, noSecondTouch, direction
                );

                if (!message) {
                    NSLog(@"[SimBridge] touchMessageForTouchAt: returned NULL "
                           "(pt=%.3f,%.3f dir=%d)", pt.x, pt.y, direction);
                    return;
                }

                size_t msgSize = malloc_size(message);
                NSLog(@"[SimBridge] touchMessageForTouchAt: %zu bytes "
                       "(pt=%.3f,%.3f dir=%d)", msgSize, pt.x, pt.y, direction);

                ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
                    client, bridge->sendSel, message, YES, completionQ, nil
                );
                success = true;
            } @catch (NSException *e) {
                NSLog(@"[SimBridge] Client method touch exception: %@", e);
            }
        }
    });
    return success;
}

/**
 * STRATEGY 1: IndigoHID 352-byte buffer format.
 *
 * Uses IndigoHIDMessageForMouseNSEvent to create a raw HID message,
 * then wraps it in the 352-byte buffer format expected by sendWithMessage:.
 * This is the IndigoHID fallback path derived from Simulator.app disassembly.
 *
 * COORDINATES: pixel coordinates (normalized [0,1] multiplied by screenWidth/Height)
 * DIRECTION: 1=Down, 2=Move, 6=Up (from Simulator.app disassembly)
 */
static bool send_via_indigo_buffer(SimBridge *bridge, CGPoint point,
                                   int direction) {
    id client = bridge->hidClient;
    IndigoHIDMouseFn fn = bridge->indigoMouseFn;
    dispatch_queue_t completionQ = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);

    const int HID_TYPE_CONSTANT = 0x32;
    CGSize unitSize = CGSizeMake(1.0, 1.0);

    __block bool success = false;
    dispatch_sync(bridge->touchQueue, ^{
        @autoreleasepool {
            @try {
                CGPoint mutablePoint = point;
                void *indigoResult = fn(&mutablePoint, NULL, HID_TYPE_CONSTANT,
                                         direction, unitSize);
                if (!indigoResult) {
                    NSLog(@"[SimBridge] IndigoBuffer: IndigoHID returned NULL (dir=%d)", direction);
                    return;
                }

                size_t indigoSize = malloc_size(indigoResult);

                const size_t BUFFER_SIZE = 0x160; // 352 bytes
                const size_t EVENT_SIZE = 0xa0;   // 160 bytes per touch event

                void *buffer = calloc(1, BUFFER_SIZE);
                if (!buffer) { free(indigoResult); return; }

                uint8_t *buf = (uint8_t *)buffer;
                *(uint32_t *)(buf + 0x18) = EVENT_SIZE;
                buf[0x1c] = 0x2; // Single touch

                // Copy first touch data
                if (indigoSize >= 0x20 + EVENT_SIZE) {
                    memcpy(buf + 0x20, (uint8_t *)indigoResult + 0x20, EVENT_SIZE);
                } else if (indigoSize > 0x20) {
                    memcpy(buf + 0x20, (uint8_t *)indigoResult + 0x20, indigoSize - 0x20);
                }

                // Copy to second touch slot and set magic values
                uint8_t *secondTouch = buf + 0xc0;
                if (indigoSize >= 0x20 + EVENT_SIZE) {
                    memcpy(secondTouch, (uint8_t *)indigoResult + 0x20, EVENT_SIZE);
                }
                free(indigoResult); // Done reading — free the original IndigoHID buffer
                *(uint64_t *)(secondTouch + 0x10) = 0x200000001ULL;
                *(uint16_t *)(secondTouch + 0x40) = 0x8000;
                *(uint16_t *)(secondTouch + 0x5c) = 0x3ff8;
                *(uint16_t *)(secondTouch + 0x64) = 0x3ff8;
                *(uint64_t *)(secondTouch + 0x70) = 0x4012666666666666ULL; // 4.6
                *(uint64_t *)(secondTouch + 0x78) = 0x400e666666666666ULL; // 3.7

                NSLog(@"[SimBridge] IndigoBuffer: %zu bytes (indigo=%zu, dir=%d)",
                      BUFFER_SIZE, indigoSize, direction);

                ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
                    client, bridge->sendSel, buffer, YES, completionQ, nil
                );
                success = true;
            } @catch (NSException *e) {
                NSLog(@"[SimBridge] IndigoBuffer touch exception: %@", e);
            }
        }
    });

    return success;
}

/**
 * STRATEGY 2: Send raw IndigoHID result directly (no 352-byte buffer wrapping).
 *
 * Some macOS versions may work without the 352-byte buffer format.
 * We try passing the raw IndigoHID result directly to sendWithMessage:.
 * Uses a copy to avoid double-free issues.
 */
static bool send_via_raw_indigo(SimBridge *bridge, CGPoint point,
                                 CGSize size, int direction,
                                 const char *label) {
    IndigoHIDMouseFn fn = bridge->indigoMouseFn;
    id client = bridge->hidClient;
    dispatch_queue_t completionQ = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
    const int HID_TYPE = 0x32;

    __block bool success = false;
    dispatch_sync(bridge->touchQueue, ^{
        @autoreleasepool {
            @try {
                CGPoint mPt = point;
                void *result = fn(&mPt, NULL, HID_TYPE, direction, size);
                if (!result) {
                    NSLog(@"[SimBridge] %s: NULL (pt=%.1f,%.1f sz=%.0f,%.0f dir=%d)",
                          label, point.x, point.y, size.width, size.height, direction);
                    return;
                }
                size_t rSize = malloc_size(result);

                // Copy so sendWithMessage: can safely free it
                void *buf = malloc(rSize);
                if (!buf) { free(result); return; }
                memcpy(buf, result, rSize);
                free(result); // Free the original IndigoHID buffer

                NSLog(@"[SimBridge] %s: %zu bytes (pt=%.1f,%.1f sz=%.0f,%.0f)",
                      label, rSize, point.x, point.y, size.width, size.height);

                ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
                    client, bridge->sendSel, buf, YES, completionQ, nil
                );
                success = true;
            } @catch (NSException *e) {
                NSLog(@"[SimBridge] %s exception: %@", label, e);
            }
        }
    });
    return success;
}

// ============================================================================
// MARK: - Main touch dispatcher
// ============================================================================

bool send_touch_event(SimBridge *bridge, double x, double y, int phase) {
    if (!bridge || !bridge->hidClient) {
        NSLog(@"[SimBridge] Touch: no bridge or HID client");
        return false;
    }

    if (!bridge->touchInitialized) {
        init_touch_system(bridge);
    }

    if (bridge->screenWidth <= 0 || bridge->screenHeight <= 0) {
        NSLog(@"[SimBridge] Touch: invalid screen dimensions (%.0fx%.0f)",
              bridge->screenWidth, bridge->screenHeight);
        return false;
    }

    // Check required selectors
    if (!bridge->sendSel || ![bridge->hidClient respondsToSelector:bridge->sendSel]) {
        NSLog(@"[SimBridge] Touch: HID client missing sendWithMessage: method");
        return false;
    }

    NSTimeInterval now = [[NSProcessInfo processInfo] systemUptime];

    // Throttle move events to ~60fps max
    if (phase == 1) {
        if ((now - bridge->lastTouchTime) < kMinMoveInterval) {
            return true; // Skip, too soon
        }
        if (!bridge->touchActive) {
            return true; // Skip orphan moves
        }
    }
    bridge->lastTouchTime = now;

    // Convert normalized coords [0,1] to screen pixels
    double screenX = x * bridge->screenWidth;
    double screenY = y * bridge->screenHeight;
    screenX = fmax(1, fmin(screenX, bridge->screenWidth - 2));
    screenY = fmax(1, fmin(screenY, bridge->screenHeight - 2));

    // Map phase to IndigoHID direction values (from Simulator.app disassembly)
    int direction;
    switch (phase) {
        case 0: direction = 1; bridge->touchActive = true;  break; // began
        case 1: direction = 2;                               break; // moved
        case 2: direction = 6; bridge->touchActive = false;  break; // ended
        default: return false;
    }

    CGPoint pixelPt = CGPointMake(screenX, screenY);

    NSLog(@"[SimBridge] Touch: norm=(%.3f,%.3f) px=(%.0f,%.0f) phase=%d dir=%d "
           "screen=%.0fx%.0f strategy=%d",
          x, y, screenX, screenY, phase, direction,
          bridge->screenWidth, bridge->screenHeight, bridge->touchStrategy);

    // ========================================================================
    // Dispatch to selected strategy
    // ========================================================================

    switch (bridge->touchStrategy) {
        case 0: {
            // Strategy 0: Client method (touchMessageForTouchAt:)
            // Try pixel coordinates first (matches IndigoHID pattern),
            // then normalized [0,1], then points (pixels / scale_factor)
            if (send_via_client_method(bridge, pixelPt, direction)) return true;

            CGPoint normPt = CGPointMake(x, y);
            if (send_via_client_method(bridge, normPt, direction)) return true;

            // Try point coordinates (2x and 3x retina scale factors)
            CGPoint pt2x = CGPointMake(screenX / 2.0, screenY / 2.0);
            if (send_via_client_method(bridge, pt2x, direction)) return true;

            CGPoint pt3x = CGPointMake(screenX / 3.0, screenY / 3.0);
            if (send_via_client_method(bridge, pt3x, direction)) return true;

            NSLog(@"[SimBridge] Client method: all coordinate variants failed");

            // Fall through to IndigoHID buffer
            if (bridge->indigoVerified) {
                NSLog(@"[SimBridge] Falling through to IndigoHID buffer");
                return send_via_indigo_buffer(bridge, pixelPt, direction);
            }
            return false;
        }

        case 1: {
            // Strategy 1: IndigoHID buffer format (pixel coordinates)
            if (send_via_indigo_buffer(bridge, pixelPt, direction)) return true;

            NSLog(@"[SimBridge] IndigoHID buffer failed, trying raw IndigoHID variants");

            // Try raw IndigoHID with various coordinate/size combinations
            // B1: pixel coords + screen size
            CGSize screenSz = CGSizeMake(bridge->screenWidth, bridge->screenHeight);
            if (send_via_raw_indigo(bridge, pixelPt, screenSz, direction,
                                     "raw-px-screen")) return true;

            // B2: normalized [0,1] + unit size
            CGPoint normPt = CGPointMake(x, y);
            if (send_via_raw_indigo(bridge, normPt, CGSizeMake(1.0, 1.0),
                                     direction, "raw-norm-unit")) return true;

            // B3: normalized + screen size
            if (send_via_raw_indigo(bridge, normPt, screenSz,
                                     direction, "raw-norm-screen")) return true;

            return false;
        }

        default: {
            // No strategy determined — try everything
            NSLog(@"[SimBridge] No strategy — trying all approaches");

            // Try client method with pixel coords
            if (bridge->touchMsgSel && [bridge->hidClient respondsToSelector:bridge->touchMsgSel]) {
                if (send_via_client_method(bridge, pixelPt, direction)) return true;
                CGPoint normPt = CGPointMake(x, y);
                if (send_via_client_method(bridge, normPt, direction)) return true;
            }

            // Try IndigoHID buffer
            if (bridge->indigoMouseFn) {
                if (send_via_indigo_buffer(bridge, pixelPt, direction)) return true;
                // Try raw with various coords
                CGPoint normPt = CGPointMake(x, y);
                if (send_via_raw_indigo(bridge, normPt, CGSizeMake(1.0, 1.0),
                                         direction, "fallback-norm")) return true;
            }

            NSLog(@"[SimBridge] All touch strategies failed");
            return false;
        }
    }
}

// ============================================================================
// MARK: - Scroll/Wheel injection
// ============================================================================

bool send_scroll_event(SimBridge *bridge, double x, double y, double dx, double dy) {
    if (!bridge || !bridge->hidClient) {
        NSLog(@"[SimBridge] Scroll: Invalid bridge or no HID client");
        return false;
    }

    if (bridge->screenWidth <= 0 || bridge->screenHeight <= 0) {
        NSLog(@"[SimBridge] Scroll: Invalid screen dimensions (%.0fx%.0f)",
              bridge->screenWidth, bridge->screenHeight);
        return false;
    }

    if (!bridge->touchInitialized) {
        init_touch_system(bridge);
    }

    if (!bridge->indigoMouseFn) {
        NSLog(@"[SimBridge] Scroll: IndigoHID not available");
        return false;
    }

    double screenX = x * bridge->screenWidth;
    double screenY = y * bridge->screenHeight;
    screenX = fmax(1, fmin(screenX, bridge->screenWidth - 2));
    screenY = fmax(1, fmin(screenY, bridge->screenHeight - 2));

    NSLog(@"[SimBridge] Scroll: (%.0f,%.0f) dx=%.2f dy=%.2f screen=%.0fx%.0f",
          screenX, screenY, dx, dy, bridge->screenWidth, bridge->screenHeight);

    if (!bridge->sendSel || ![bridge->hidClient respondsToSelector:bridge->sendSel]) {
        NSLog(@"[SimBridge] HID client missing sendWithMessage: method");
        return false;
    }

    id client = bridge->hidClient;
    IndigoHIDMouseFn fn = bridge->indigoMouseFn;
    // Use a separate queue for completion to avoid deadlocking touchQueue
    dispatch_queue_t completionQ = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);

    __block bool success = false;
    dispatch_sync(bridge->touchQueue, ^{
        @autoreleasepool {
            @try {
                CGPoint point1 = CGPointMake(screenX, screenY);
                CGSize unitSize = CGSizeMake(1.0, 1.0);
                const int HID_TYPE_CONSTANT = 0x32;
                // TODO: dx/dy are currently unused. IndigoHID direction=22 generates
                // a fixed scroll event regardless of magnitude. To support variable
                // scroll speed, we'd need to reverse-engineer additional IndigoHID
                // direction codes or patch the HID message buffer directly.
                const int SCROLL_DIRECTION = 22;

                void *indigoResult = fn(&point1, NULL, HID_TYPE_CONSTANT,
                                         SCROLL_DIRECTION, unitSize);
                if (!indigoResult) {
                    NSLog(@"[SimBridge] IndigoHID returned NULL for scroll");
                    return;
                }

                size_t indigoSize = malloc_size(indigoResult);

                void *buffer = malloc(indigoSize);
                if (buffer) {
                    memcpy(buffer, indigoResult, indigoSize);
                    free(indigoResult);

                    ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
                        client, bridge->sendSel, buffer, YES, completionQ, nil
                    );
                    success = true;
                    NSLog(@"[SimBridge] Scroll sent (%zu bytes)", indigoSize);
                } else {
                    free(indigoResult);
                }

            } @catch (NSException *e) {
                NSLog(@"[SimBridge] Scroll exception: %@", e);
            }
        }
    });

    return success;
}

// ============================================================================
// MARK: - Keyboard injection
// ============================================================================

bool send_key_event(SimBridge *bridge, uint16_t keycode, int direction) {
    if (!bridge || !bridge->hidClient) {
        NSLog(@"[SimBridge] Key: Invalid bridge or no HID client");
        return false;
    }

    if (!bridge->touchInitialized) {
        init_touch_system(bridge);
    }

    if (!bridge->indigoKeyboardFn) {
        NSLog(@"[SimBridge] Key: IndigoHIDMessageForKeyboardArbitrary not available");
        return false;
    }

    NSLog(@"[SimBridge] Key: keycode=0x%04x direction=%d", keycode, direction);

    if (!bridge->sendSel || ![bridge->hidClient respondsToSelector:bridge->sendSel]) {
        NSLog(@"[SimBridge] HID client missing sendWithMessage: method");
        return false;
    }

    id client = bridge->hidClient;
    IndigoHIDKeyboardFn fn = bridge->indigoKeyboardFn;
    dispatch_queue_t completionQ = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);

    __block bool success = false;
    dispatch_sync(bridge->touchQueue, ^{
        @autoreleasepool {
            @try {
                void *indigoResult = fn(keycode, direction);
                if (!indigoResult) {
                    NSLog(@"[SimBridge] IndigoHID returned NULL for key");
                    return;
                }

                size_t indigoSize = malloc_size(indigoResult);

                void *buffer = malloc(indigoSize);
                if (buffer) {
                    memcpy(buffer, indigoResult, indigoSize);
                    free(indigoResult);

                    ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
                        client, bridge->sendSel, buffer, YES, completionQ, nil
                    );
                    success = true;
                    NSLog(@"[SimBridge] Key sent (keycode=0x%04x, %zu bytes)", keycode, indigoSize);
                } else {
                    free(indigoResult);
                }

            } @catch (NSException *e) {
                NSLog(@"[SimBridge] Key exception: %@", e);
            }
        }
    });

    return success;
}

// ============================================================================
// MARK: - Button injection
// ============================================================================

bool send_button_event(SimBridge *bridge, int button_type, int direction) {
    if (!bridge || !bridge->hidClient) {
        NSLog(@"[SimBridge] Button: Invalid bridge or no HID client");
        return false;
    }

    // Lock button is not supported on iOS simulator
    if (button_type == 1) {
        NSLog(@"[SimBridge] Lock button is not supported on iOS");
        return false;
    }

    if (button_type != 0) {
        NSLog(@"[SimBridge] Button: Invalid button type %d (supported: 0=Home)",
              button_type);
        return false;
    }

    // Convert direction: our API uses 0=down, 1=up; iOS HID uses 1=down, 2=up
    int iosDirection = (direction == 0) ? 1 : 2;

    NSLog(@"[SimBridge] Button: type=%d direction=%d (ios=%d)",
          button_type, direction, iosDirection);

    // PRIMARY: Try sendButtonEventWithKeyCode:keyDirection: on HID client
    SEL sendButtonSel = NSSelectorFromString(@"sendButtonEventWithKeyCode:keyDirection:");
    if (sendButtonSel && [bridge->hidClient respondsToSelector:sendButtonSel]) {
        @try {
            int keyCode = 0x33;
            ((void (*)(id, SEL, int, int))objc_msgSend)(
                bridge->hidClient, sendButtonSel, keyCode, iosDirection
            );
            NSLog(@"[SimBridge] Button sent via sendButtonEventWithKeyCode (type=%d)", button_type);
            return true;
        } @catch (NSException *e) {
            NSLog(@"[SimBridge] sendButtonEvent exception: %@, trying IndigoHID", e);
        }
    }

    // FALLBACK: Use IndigoHIDMessageForButton
    if (!bridge->touchInitialized) {
        init_touch_system(bridge);
    }

    if (!bridge->indigoButtonFn) {
        NSLog(@"[SimBridge] Button: No button sending method available");
        return false;
    }

    if (!bridge->sendSel || ![bridge->hidClient respondsToSelector:bridge->sendSel]) {
        NSLog(@"[SimBridge] HID client missing sendWithMessage: method");
        return false;
    }

    id client = bridge->hidClient;
    IndigoHIDButtonFn fn = bridge->indigoButtonFn;
    dispatch_queue_t completionQ = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);

    __block bool success = false;
    dispatch_sync(bridge->touchQueue, ^{
        @autoreleasepool {
            @try {
                void *indigoResult = fn(0x33, button_type, iosDirection);
                if (!indigoResult) {
                    NSLog(@"[SimBridge] IndigoHID returned NULL for button");
                    return;
                }

                size_t indigoSize = malloc_size(indigoResult);
                void *buffer = malloc(indigoSize);
                if (buffer) {
                    memcpy(buffer, indigoResult, indigoSize);
                    free(indigoResult);
                    ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
                        client, bridge->sendSel, buffer, YES, completionQ, nil
                    );
                    success = true;
                    NSLog(@"[SimBridge] Button sent via IndigoHID (type=%d)", button_type);
                } else {
                    free(indigoResult);
                }
            } @catch (NSException *e) {
                NSLog(@"[SimBridge] Button IndigoHID exception: %@", e);
            }
        }
    });

    return success;
}
