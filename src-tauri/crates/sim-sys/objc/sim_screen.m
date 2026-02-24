#import "sim_bridge_internal.h"

// ============================================================================
// MARK: - Framerate improvement roadmap
// ============================================================================
//
// Current: IOSurface shared memory polling at 30fps + HW JPEG encode.
// SimulatorKit push-based callbacks are broken on modern Xcode (macOS Sequoia):
//   - SimDeviceLegacyClient class removed from runtime entirely
//   - SimScreenAdapter accepts registerScreenAdapterCallbacksWithUUID: but
//     screenConnectedCallback never fires
//   - registerScreenCallbacksWithUUID: on screen descriptors also never fires
//   - framebufferSurface property on screen descriptors DOES work (shared memory)
//
// Possible improvements (roughly prioritized):
//
// 1. ADAPTIVE FRAME RATE via IOSurface seed
//    IOSurfaceGetSeed() returns a value that increments when content changes.
//    Compare seed between polls to skip encoding unchanged frames.
//    Saves CPU during idle (home screen, static apps) while keeping full speed
//    during animations. Easy win — just add a seed check in polling loop.
//
// 2. HIGHER POLLING FREQUENCY (30fps -> 60fps)
//    Change interval from 33ms to 16ms. HW encoder can likely handle it.
//    Test CPU impact — may be marginal since VTCompressionSession is HW.
//    Diminishing returns if browser MJPEG decode can't keep up.
//
// 3. SCREENCAPTUREKIT (macOS 12.3+)
//    Apple's modern screen capture API with push-based frame delivery.
//    SCStream delivers CVPixelBuffers via delegate at configurable fps.
//    Would replace polling entirely with true event-driven frames.
//    Captures Simulator.app window directly. Requires entitlements +
//    user permission. Probably the "right" long-term solution.
//
// 4. BROWSER: fetch + canvas INSTEAD OF <img> MJPEG
//    <img src=stream.mjpeg> decodes JPEG on browser main thread.
//    fetch() + ReadableStream + createImageBitmap() + canvas.drawImage()
//    moves decode off main thread. Would unlock smoother rendering at
//    higher frame rates. More complex but removes browser bottleneck.
//
// 5. LOWER JPEG QUALITY
//    Current: 0.5. Could try 0.3-0.4 for faster encode + smaller payloads.
//    Trade-off: visible quality degradation. Profile before committing.
//
// ============================================================================

// ============================================================================
// MARK: - Frame polling
// ============================================================================

void start_frame_polling(SimBridge *bridge) {
    if (bridge->polling) return; // Already polling

    bridge->polling = true;

    int64_t interval_ms = bridge->currentSurface ? 33 : 66;  // 30fps / 15fps

    // Get UDID for simctl fallback
    __block NSString *udid = nil;
    SEL udidSel = NSSelectorFromString(@"UDID");
    if (udidSel && [bridge->simDevice respondsToSelector:udidSel]) {
        NSUUID *udidObj = ((id (*)(id, SEL))objc_msgSend)(bridge->simDevice, udidSel);
        if (udidObj) {
            udid = [udidObj UUIDString];
            NSLog(@"[SimBridge] Using UDID for simctl fallback: %@", udid);
        }
    }

    // Use a simple polling loop on a global queue instead of dispatch_source_t timer.
    // dispatch_source timers have a race condition during cancellation: the event
    // handler is cleared to NULL while an already-latched timer event is still
    // pending, causing EXC_BAD_ACCESS when GCD calls the NULL handler.
    // A polling loop with a flag check avoids this entirely.
    dispatch_group_t group = dispatch_group_create();
    bridge->pollingGroup = group;

    dispatch_group_async(group,
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSLog(@"[SimBridge] Frame polling loop started (interval=%lldms)", interval_ms);

        while (bridge->polling) {
            @autoreleasepool {
                FrameCallback cb = bridge->rustCallback;
                if (!cb) {
                    usleep((useconds_t)(interval_ms * 1000));
                    continue;
                }

                NSData *jpegData = nil;

                // Try IOSurface first — cached VT JPEG encoder (hardware-accelerated)
                // Adaptive framerate: skip encoding when screen content hasn't changed.
                // IOSurfaceGetSeed() increments on each content modification.
                if (bridge->currentSurface) {
                    uint32_t currentSeed = IOSurfaceGetSeed(bridge->currentSurface);
                    if (currentSeed == bridge->lastSurfaceSeed) {
                        // Content unchanged — skip this frame entirely
                        usleep((useconds_t)(interval_ms * 1000));
                        continue;
                    }
                    bridge->lastSurfaceSeed = currentSeed;
                    jpegData = bridge_encode_jpeg(bridge, bridge->currentSurface, 0.5f);
                }

                // Fallback to simctl screenshot
                if (!jpegData && udid) {
                    jpegData = capture_simctl_screenshot(udid);

                    // Extract dimensions from JPEG if we don't have them yet
                    if (jpegData && (bridge->screenWidth <= 0 || bridge->screenHeight <= 0)) {
                        CGImageSourceRef source = CGImageSourceCreateWithData(
                            (__bridge CFDataRef)jpegData, NULL);
                        if (source) {
                            CFDictionaryRef props = CGImageSourceCopyPropertiesAtIndex(
                                source, 0, NULL);
                            if (props) {
                                CFNumberRef widthRef = CFDictionaryGetValue(
                                    props, kCGImagePropertyPixelWidth);
                                CFNumberRef heightRef = CFDictionaryGetValue(
                                    props, kCGImagePropertyPixelHeight);
                                if (widthRef && heightRef) {
                                    int w, h;
                                    CFNumberGetValue(widthRef, kCFNumberIntType, &w);
                                    CFNumberGetValue(heightRef, kCFNumberIntType, &h);
                                    bridge->screenWidth = (double)w;
                                    bridge->screenHeight = (double)h;
                                    NSLog(@"[SimBridge] Got screen size from JPEG: %dx%d", w, h);
                                }
                                CFRelease(props);
                            }
                            CFRelease(source);
                        }
                    }
                }

                if (jpegData && jpegData.length > 0 && cb) {
                    cb(
                        bridge->rustContext,
                        (const uint8_t *)jpegData.bytes,
                        (uint64_t)jpegData.length
                    );
                }
            }
            usleep((useconds_t)(interval_ms * 1000));
        }

        NSLog(@"[SimBridge] Frame polling loop exited");
    });

    NSLog(@"[SimBridge] Started frame polling (surface=%p, udid=%@)",
          bridge->currentSurface, udid ?: @"nil");
}

void stop_frame_polling(SimBridge *bridge) {
    if (!bridge->polling) return;

    // Signal the polling loop to exit. The loop checks this flag each iteration
    // and will exit within one interval (~66ms max).
    bridge->polling = false;

    // Wait for the polling loop to finish (up to 2 seconds).
    if (bridge->pollingGroup) {
        long result = dispatch_group_wait(bridge->pollingGroup,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
        if (result != 0) {
            NSLog(@"[SimBridge] Warning: frame polling loop did not exit in time");
        }
        bridge->pollingGroup = NULL;
    }

    NSLog(@"[SimBridge] Stopped frame polling");
}

// ============================================================================
// MARK: - SimDevice lookup
// ============================================================================

id find_sim_device(const char* udid_str, id *out_device_set, char* error_buf, int error_buf_len) {
    NSString *udidString = [NSString stringWithUTF8String:udid_str];

    // Get SimServiceContext.sharedServiceContext
    Class serviceContextClass = NSClassFromString(@"SimServiceContext");
    if (!serviceContextClass) {
        snprintf(error_buf, error_buf_len,
                 "SimServiceContext class not found. CoreSimulator may not be loaded.");
        return nil;
    }

    // sharedServiceContextForDeveloperDir:error: (Xcode 16+)
    // Falls back to sharedServiceContext for older Xcode versions
    id sharedContext = nil;

    SEL sharedDirSel = NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:");
    if ([serviceContextClass respondsToSelector:sharedDirSel]) {
        NSString *devPath = get_xcode_developer_path();
        NSError *ctxError = nil;
        sharedContext = ((id (*)(id, SEL, NSString*, NSError**))objc_msgSend)(
            (id)serviceContextClass, sharedDirSel, devPath, &ctxError
        );
        if (!sharedContext) {
            snprintf(error_buf, error_buf_len,
                     "sharedServiceContextForDeveloperDir failed: %s",
                     [[ctxError localizedDescription] UTF8String] ?: "unknown error");
            return nil;
        }
    } else {
        // Fallback for older Xcode
        SEL sharedSel = NSSelectorFromString(@"sharedServiceContext");
        if ([serviceContextClass respondsToSelector:sharedSel]) {
            sharedContext = ((id (*)(id, SEL))objc_msgSend)((id)serviceContextClass, sharedSel);
        }
    }

    if (!sharedContext) {
        snprintf(error_buf, error_buf_len,
                 "Failed to get SimServiceContext. No compatible API found.");
        return nil;
    }

    // Get device set — try the standard CoreSimulator device path first,
    // then fall back to the default device set
    id deviceSet = nil;
    NSError *error = nil;

    // Standard device set path: ~/Library/Developer/CoreSimulator/Devices
    NSString *homePath = NSHomeDirectory();
    NSString *defaultSetPath = [homePath stringByAppendingPathComponent:
        @"Library/Developer/CoreSimulator/Devices"];

    SEL setWithPathSel = NSSelectorFromString(@"deviceSetWithPath:error:");
    if (setWithPathSel && [sharedContext respondsToSelector:setWithPathSel]) {
        deviceSet = ((id (*)(id, SEL, NSString*, NSError**))objc_msgSend)(
            sharedContext, setWithPathSel, defaultSetPath, &error
        );
        NSLog(@"[SimBridge] deviceSetWithPath:%@ -> %@ (error: %@)",
              defaultSetPath, deviceSet, error);
    }

    // Fallback to defaultDeviceSetWithError:
    if (!deviceSet) {
        SEL deviceSetSel = NSSelectorFromString(@"defaultDeviceSetWithError:");
        error = nil;
        deviceSet = ((id (*)(id, SEL, NSError**))objc_msgSend)(
            sharedContext, deviceSetSel, &error
        );
        NSLog(@"[SimBridge] defaultDeviceSetWithError -> %@ (error: %@)",
              deviceSet, error);
    }

    if (!deviceSet) {
        snprintf(error_buf, error_buf_len,
                 "Failed to get device set: %s",
                 [[error localizedDescription] UTF8String] ?: "unknown error");
        return nil;
    }

    // devicesByUDID
    SEL devicesByUDIDSel = NSSelectorFromString(@"devicesByUDID");
    NSDictionary *devicesByUDID = ((id (*)(id, SEL))objc_msgSend)(deviceSet, devicesByUDIDSel);
    NSLog(@"[SimBridge] devicesByUDID count: %lu, keys: %@",
          (unsigned long)devicesByUDID.count,
          [[devicesByUDID allKeys] componentsJoinedByString:@", "]);

    if (!devicesByUDID || devicesByUDID.count == 0) {
        // Try alternative: devices property (NSArray)
        SEL devicesSel = NSSelectorFromString(@"devices");
        if (devicesSel && [deviceSet respondsToSelector:devicesSel]) {
            NSArray *devicesArray = ((id (*)(id, SEL))objc_msgSend)(deviceSet, devicesSel);
            NSLog(@"[SimBridge] devices array count: %lu", (unsigned long)devicesArray.count);

            // Search by UDID in the array
            for (id dev in devicesArray) {
                SEL devUdidSel = NSSelectorFromString(@"UDID");
                if (!devUdidSel) devUdidSel = NSSelectorFromString(@"udid");
                if (devUdidSel && [dev respondsToSelector:devUdidSel]) {
                    id devUDID = ((id (*)(id, SEL))objc_msgSend)(dev, devUdidSel);
                    // devUDID may be NSUUID or NSString
                    NSString *devUDIDStr = [devUDID isKindOfClass:[NSString class]]
                        ? devUDID : [devUDID UUIDString];
                    if (devUDIDStr && [devUDIDStr caseInsensitiveCompare:udidString] == NSOrderedSame) {
                        NSLog(@"[SimBridge] Found device via devices array: %@", devUDIDStr);
                        if (out_device_set) *out_device_set = deviceSet;
                        return dev;
                    }
                }
            }
        }

        snprintf(error_buf, error_buf_len,
                 "No devices found in device set at %s",
                 [defaultSetPath UTF8String]);
        return nil;
    }

    // Keys in devicesByUDID are NSUUID objects, not NSString.
    id device = nil;
    NSUUID *targetUUID = [[NSUUID alloc] initWithUUIDString:udidString];
    if (targetUUID) {
        device = devicesByUDID[targetUUID];
    }
    if (!device) {
        // Fallback: iterate and compare string representations
        for (id key in devicesByUDID) {
            NSString *keyStr = [key isKindOfClass:[NSString class]] ? key : [key description];
            if ([keyStr caseInsensitiveCompare:udidString] == NSOrderedSame) {
                device = devicesByUDID[key];
                break;
            }
        }
    }
    if (!device) {
        snprintf(error_buf, error_buf_len,
                 "Simulator with UDID %s not found in set with %lu devices",
                 udid_str, (unsigned long)devicesByUDID.count);
        return nil;
    }

    if (out_device_set) *out_device_set = deviceSet;
    return device;
}

// ============================================================================
// MARK: - "Latest only" encode scheduling (avoids frame backlog)
// ============================================================================

// Called ONLY from frameQueue (serial). Checks if there's a pending surface
// to encode, and if so, dispatches ONE encode operation to encodeQueue.
// When encoding finishes, bounces back to frameQueue to check for more work.
// This ensures we NEVER build a backlog — at most one encode is in-flight,
// and intermediate frames are skipped (only the latest surface is used).
void schedule_encode(SimBridge *bridge) {
    // Grab the pending surface (take ownership)
    IOSurfaceRef surface = bridge->pendingSurface;
    bridge->pendingSurface = NULL;

    if (!surface) {
        // No work to do — mark encoder as idle
        bridge->encodeInFlight = false;
        return;
    }

    bridge->encodeInFlight = true;

    dispatch_async(bridge->encodeQueue, ^{
        @autoreleasepool {
            NSData *jpegData = bridge_encode_jpeg(bridge, surface, 0.5f);
            CFRelease(surface);

            if (jpegData && jpegData.length > 0) {
                // Read callback pointer directly — if bridge is being destroyed,
                // rustCallback will be NULL and we skip the call.
                FrameCallback cb = bridge->rustCallback;
                void *ctx = bridge->rustContext;
                if (cb) {
                    cb(ctx,
                       (const uint8_t *)jpegData.bytes,
                       (uint64_t)jpegData.length);
                    bridge->frameDeliveredToRust = true;
                }
            }

            // Bounce back to frameQueue to check for pending work.
            // This serializes access to pendingSurface/encodeInFlight.
            dispatch_async(bridge->frameQueue, ^{
                schedule_encode(bridge);
            });
        }
    });
}

// ============================================================================
// MARK: - Screen capture via SimDeviceScreen
// ============================================================================

static void register_frame_callbacks_on_screen(SimBridge *bridge, id screen, dispatch_semaphore_t sema) {
    SEL regSel = NSSelectorFromString(
        @"registerScreenCallbacksWithUUID:"
         "callbackQueue:frameCallback:"
         "surfacesChangedCallback:propertiesChangedCallback:");

    if (![screen respondsToSelector:regSel]) {
        NSLog(@"[SimBridge] Screen %@ does not respond to registerScreenCallbacks",
              [screen class]);
        if (sema) dispatch_semaphore_signal(sema);
        return;
    }

    bridge->screenObject = screen;
    NSUUID *uuid = [NSUUID UUID];
    bridge->callbackUUID = uuid;

    SimBridge *capturedBridge = bridge;

    // Frame callback: (IOSurface *back, IOSurface *front)
    // CRITICAL: This runs on the serial frameQueue. We do NOT encode here.
    // Instead, we store the latest surface and kick off encoding only when
    // the encoder is idle. If frames arrive faster than encoding, intermediate
    // surfaces are silently dropped — only the latest matters.
    void (^frameCallback)(id, id) = ^(id backSurface, id frontSurface) {
        capturedBridge->adapterCallbacksActive = true;
        capturedBridge->iosurfaceFrameCount++;

        if (capturedBridge->iosurfaceFrameCount == 1) {
            NSLog(@"[SimBridge] First IOSurface frame callback fired!");
        } else if (capturedBridge->iosurfaceFrameCount % 300 == 0) {
            NSLog(@"[SimBridge] IOSurface frame #%llu", capturedBridge->iosurfaceFrameCount);
        }

        if (!capturedBridge->rustCallback) return;

        id surfaceToUse = frontSurface ?: backSurface;
        if (!surfaceToUse) return;

        // Store the latest surface (swap old for new)
        IOSurfaceRef newSurface = (IOSurfaceRef)CFRetain((__bridge IOSurfaceRef)surfaceToUse);
        IOSurfaceRef old = capturedBridge->pendingSurface;
        capturedBridge->pendingSurface = newSurface;
        if (old) CFRelease(old);

        // If encoder is idle, kick it off
        if (!capturedBridge->encodeInFlight) {
            schedule_encode(capturedBridge);
        }
        // Otherwise, the in-flight encode will pick up pendingSurface when it finishes
    };

    // Surfaces changed callback
    void (^surfacesChangedCallback)(NSArray*, NSError*) = ^(NSArray *surfaces, NSError *error) {
        NSLog(@"[SimBridge] surfacesChangedCallback: %lu surfaces, error=%@",
              (unsigned long)(surfaces ? surfaces.count : 0), error);
        if (surfaces && surfaces.count > 0) {
            id firstSurface = surfaces[0];
            IOSurfaceRef newRef = (__bridge IOSurfaceRef)firstSurface;
            if (capturedBridge->currentSurface && capturedBridge->currentSurface != newRef) {
                CFRelease(capturedBridge->currentSurface);
            }
            capturedBridge->currentSurface = (IOSurfaceRef)CFRetain(newRef);
            capturedBridge->screenWidth = (double)IOSurfaceGetWidth(newRef);
            capturedBridge->screenHeight = (double)IOSurfaceGetHeight(newRef);
            NSLog(@"[SimBridge] New IOSurface: %zux%zu",
                  IOSurfaceGetWidth(newRef), IOSurfaceGetHeight(newRef));
        }
    };

    // Properties changed callback
    void (^propertiesChangedCallback)(id) = ^(__unused id props) {
        NSLog(@"[SimBridge] propertiesChangedCallback: %@", props);
    };

    ((void (*)(id, SEL, NSUUID*, dispatch_queue_t, id, id, id))objc_msgSend)(
        screen, regSel, uuid, capturedBridge->frameQueue,
        frameCallback, surfacesChangedCallback, propertiesChangedCallback
    );

    NSLog(@"[SimBridge] Frame callbacks registered on screen %@ with UUID: %@",
          [screen class], uuid);

    if (sema) dispatch_semaphore_signal(sema);
}

// Try to fetch IOSurface directly from a screen object using known selectors
IOSurfaceRef try_get_surface_from_screen(id screenObject) {
    if (!screenObject) return NULL;

    SEL selectors[] = {
        NSSelectorFromString(@"framebufferSurface"),
        NSSelectorFromString(@"ioSurface"),
        NSSelectorFromString(@"surface"),
        NSSelectorFromString(@"displaySurface"),
    };

    for (int i = 0; i < sizeof(selectors)/sizeof(selectors[0]); i++) {
        SEL sel = selectors[i];
        if (sel && [screenObject respondsToSelector:sel]) {
            id surface = ((id (*)(id, SEL))objc_msgSend)(screenObject, sel);
            if (surface) {
                NSLog(@"[SimBridge] Got IOSurface via %@", NSStringFromSelector(sel));
                return (__bridge IOSurfaceRef)surface;
            }
        }
    }

    SEL currentSurfacesSel = NSSelectorFromString(@"currentSurfaces");
    if (currentSurfacesSel && [screenObject respondsToSelector:currentSurfacesSel]) {
        NSArray *surfaces = ((id (*)(id, SEL))objc_msgSend)(screenObject, currentSurfacesSel);
        if (surfaces && surfaces.count > 0) {
            NSLog(@"[SimBridge] Got IOSurface from currentSurfaces array");
            return (__bridge IOSurfaceRef)surfaces[0];
        }
    }

    return NULL;
}

bool setup_screen_capture(SimBridge *bridge, char* error_buf, int error_buf_len) {
    bridge->frameQueue = dispatch_queue_create(
        "com.hivenet.sim-bridge.frames",
        DISPATCH_QUEUE_SERIAL
    );
    bridge->encodeQueue = dispatch_queue_create(
        "com.hivenet.sim-bridge.encode",
        DISPATCH_QUEUE_SERIAL
    );

    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    __block bool registered = false;
    SimBridge *capturedBridge = bridge;

    // Shared selectors
    SEL adapterSel = NSSelectorFromString(
        @"registerScreenAdapterCallbacksWithUUID:"
         "callbackQueue:screenConnectedCallback:"
         "screenWillDisconnectCallback:");

    void (^screenConnectedCallback)(id) = ^(id screen) {
        NSLog(@"[SimBridge] screenConnectedCallback: screen=%@ (class=%@)",
              screen, [screen class]);
        if (!screen) {
            dispatch_semaphore_signal(sema);
            return;
        }
        register_frame_callbacks_on_screen(capturedBridge, screen, sema);
        registered = true;
    };

    void (^screenWillDisconnectCallback)(unsigned int) = ^(unsigned int displayId) {
        NSLog(@"[SimBridge] screenWillDisconnectCallback: displayId=%u", displayId);
    };

    // Helper: try adapter registration on an object
    BOOL (^tryAdapterRegistration)(id, NSString*) = ^BOOL(id target, NSString *label) {
        if (!target || !adapterSel || ![target respondsToSelector:adapterSel]) {
            return NO;
        }
        NSLog(@"[SimBridge] %@ responds to registerScreenAdapterCallbacks — trying it", label);

        NSUUID *adapterUUID = [NSUUID UUID];
        capturedBridge->adapterCallbackUUID = adapterUUID;
        capturedBridge->legacyClient = target;

        @try {
            ((void (*)(id, SEL, NSUUID*, dispatch_queue_t, id, id))objc_msgSend)(
                target, adapterSel, adapterUUID, capturedBridge->frameQueue,
                screenConnectedCallback, screenWillDisconnectCallback
            );
            NSLog(@"[SimBridge] Registered adapter callbacks on %@ (UUID: %@)", label, adapterUUID);
            return YES;
        } @catch (NSException *exception) {
            NSLog(@"[SimBridge] Adapter registration on %@ threw: %@", label, exception);
            capturedBridge->adapterCallbackUUID = nil;
            capturedBridge->legacyClient = nil;
            return NO;
        }
    };

    // Get device UDID
    NSUUID *deviceUUID = nil;
    SEL udidSel = NSSelectorFromString(@"UDID");
    if (udidSel && [bridge->simDevice respondsToSelector:udidSel]) {
        deviceUUID = ((id (*)(id, SEL))objc_msgSend)(bridge->simDevice, udidSel);
    }

    // ========================================================================
    // DIAGNOSTIC: Enumerate all classes with "LegacyClient" in name
    // ========================================================================
    {
        unsigned int classCount = 0;
        Class *classes = objc_copyClassList(&classCount);
        NSMutableArray *legacyClasses = [NSMutableArray array];
        for (unsigned int i = 0; i < classCount; i++) {
            const char *name = class_getName(classes[i]);
            if (name && strstr(name, "LegacyClient") != NULL) {
                [legacyClasses addObject:[NSString stringWithUTF8String:name]];
            }
        }
        free(classes);
        NSLog(@"[SimBridge] Runtime classes matching 'LegacyClient': %@",
              legacyClasses.count > 0 ? [legacyClasses componentsJoinedByString:@", "] : @"(none)");
    }

    // ========================================================================
    // APPROACH 1: Create SimDeviceLegacyClient or similar
    // Try known class names, then runtime search
    // ========================================================================
    BOOL adapterRegistered = NO;

    if (deviceUUID && bridge->deviceSet) {
        // Try multiple class names
        NSArray *candidateNames = @[
            @"SimDeviceLegacyClient",
            @"SimulatorKit.SimDeviceLegacyClient",
            @"_TtC12SimulatorKit21SimDeviceLegacyClient",
        ];

        Class clientClass = nil;
        for (NSString *name in candidateNames) {
            clientClass = NSClassFromString(name);
            if (clientClass) {
                NSLog(@"[SimBridge] Found client class: %@", name);
                break;
            }
        }

        // Runtime fallback: search for any class with "LegacyClient" but not "HID"
        if (!clientClass) {
            unsigned int classCount = 0;
            Class *classes = objc_copyClassList(&classCount);
            for (unsigned int i = 0; i < classCount; i++) {
                const char *name = class_getName(classes[i]);
                if (name && strstr(name, "LegacyClient") && !strstr(name, "HID")) {
                    clientClass = classes[i];
                    NSLog(@"[SimBridge] Found non-HID LegacyClient: %s", name);
                    break;
                }
            }
            free(classes);
        }

        if (clientClass) {
            NSLog(@"[SimBridge] Creating %s (LegacyClient pattern)", class_getName(clientClass));

            // Try initWithUDID:deviceSet: first, then initWithDevice:error:
            SEL initSelectors[] = {
                NSSelectorFromString(@"initWithUDID:deviceSet:"),
                NSSelectorFromString(@"initWithDevice:error:"),
            };

            for (int i = 0; i < 2; i++) {
                SEL initSel = initSelectors[i];
                @try {
                    id client = [clientClass alloc];
                    if (!initSel || ![client respondsToSelector:initSel]) continue;

                    if (i == 0) {
                        client = ((id (*)(id, SEL, id, id))objc_msgSend)(
                            client, initSel, deviceUUID, bridge->deviceSet);
                    } else {
                        NSError *initError = nil;
                        client = ((id (*)(id, SEL, id, NSError**))objc_msgSend)(
                            client, initSel, bridge->simDevice, &initError);
                        if (initError) {
                            NSLog(@"[SimBridge] %s init error: %@", class_getName(clientClass), initError);
                        }
                    }

                    if (client) {
                        NSLog(@"[SimBridge] Created %s via %@", class_getName(clientClass),
                              NSStringFromSelector(initSel));
                        adapterRegistered = tryAdapterRegistration(client,
                            [NSString stringWithUTF8String:class_getName(clientClass)]);
                        if (adapterRegistered) break;
                    }
                } @catch (NSException *exception) {
                    NSLog(@"[SimBridge] %s init threw: %@", class_getName(clientClass), exception);
                }
            }
        } else {
            NSLog(@"[SimBridge] No LegacyClient class found in runtime");
        }
    }

    // Wait for approach 1 (3 seconds)
    if (adapterRegistered) {
        dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC));
        long result = dispatch_semaphore_wait(sema, timeout);
        if (result == 0 && registered) {
            bridge->adapterCallbacksActive = true;
            NSLog(@"[SimBridge] Screen capture via LegacyClient — IOSurface callbacks active!");
            return true;
        }
        NSLog(@"[SimBridge] LegacyClient adapter timed out (3s) — trying other approaches");
    }

    // ========================================================================
    // APPROACH 2: Try adapter registration on SimDevice itself
    // ========================================================================
    if (!adapterRegistered) {
        adapterRegistered = tryAdapterRegistration(bridge->simDevice, @"SimDevice");
        if (adapterRegistered) {
            sema = dispatch_semaphore_create(0);
            dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC));
            long result = dispatch_semaphore_wait(sema, timeout);
            if (result == 0 && registered) {
                bridge->adapterCallbacksActive = true;
                NSLog(@"[SimBridge] Screen capture via SimDevice adapter — IOSurface callbacks active!");
                return true;
            }
            NSLog(@"[SimBridge] SimDevice adapter timed out (3s)");
        }
    }

    // ========================================================================
    // APPROACH 3: Try IO ports — adapter registration on ports AND descriptors
    // Also collect screen objects for IOSurface direct access
    // ========================================================================
    SEL ioSel = NSSelectorFromString(@"io");
    id deviceIO = nil;
    if (ioSel && [bridge->simDevice respondsToSelector:ioSel]) {
        deviceIO = ((id (*)(id, SEL))objc_msgSend)(bridge->simDevice, ioSel);
    }

    NSArray *ports = nil;
    if (deviceIO) {
        SEL ioPortsSel = NSSelectorFromString(@"ioPorts");
        if (ioPortsSel && [deviceIO respondsToSelector:ioPortsSel]) {
            ports = ((id (*)(id, SEL))objc_msgSend)(deviceIO, ioPortsSel);
        }
    }

    NSMutableArray *screenDescriptors = [NSMutableArray array]; // Descriptors that look like screens

    if (ports && ports.count > 0) {
        NSLog(@"[SimBridge] Found %lu IO ports — scanning ALL for adapter support and screens",
              (unsigned long)ports.count);

        // First pass: try adapter registration on all ports and descriptors
        for (id port in ports) {
            SEL descriptorSel = NSSelectorFromString(@"descriptor");
            if (![port respondsToSelector:descriptorSel]) continue;

            id descriptor = ((id (*)(id, SEL))objc_msgSend)(port, descriptorSel);
            if (!descriptor) continue;

            NSString *descClass = NSStringFromClass([descriptor class]);
            NSLog(@"[SimBridge] Port descriptor: %@", descClass);

            // Check if descriptor responds to screen callbacks (it's a screen)
            SEL regScreenSel = NSSelectorFromString(
                @"registerScreenCallbacksWithUUID:"
                 "callbackQueue:frameCallback:"
                 "surfacesChangedCallback:propertiesChangedCallback:");
            if ([descriptor respondsToSelector:regScreenSel]) {
                [screenDescriptors addObject:descriptor];
                NSLog(@"[SimBridge]   ^ is a screen (supports registerScreenCallbacks)");
            }

            // Try adapter registration on descriptor
            if (!adapterRegistered) {
                adapterRegistered = tryAdapterRegistration(descriptor,
                    [NSString stringWithFormat:@"descriptor(%@)", descClass]);
            }

            // Also try on the port itself
            if (!adapterRegistered) {
                NSString *portClass = NSStringFromClass([port class]);
                if ([port respondsToSelector:adapterSel]) {
                    adapterRegistered = tryAdapterRegistration(port,
                        [NSString stringWithFormat:@"port(%@)", portClass]);
                }
            }
        }

        // Wait for adapter registration from ports
        if (adapterRegistered && !registered) {
            sema = dispatch_semaphore_create(0);
            dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC));
            long result = dispatch_semaphore_wait(sema, timeout);
            if (result == 0 && registered) {
                bridge->adapterCallbacksActive = true;
                NSLog(@"[SimBridge] Screen capture via port adapter — IOSurface callbacks active!");
                return true;
            }
            NSLog(@"[SimBridge] Port adapter timed out (5s)");
        }

        // Second pass: try enumerateScreens on descriptors
        if (!registered) {
            for (id port in ports) {
                SEL descriptorSel = NSSelectorFromString(@"descriptor");
                if (![port respondsToSelector:descriptorSel]) continue;
                id descriptor = ((id (*)(id, SEL))objc_msgSend)(port, descriptorSel);
                if (!descriptor) continue;

                SEL enumSel = NSSelectorFromString(
                    @"enumerateScreensWithCompletionQueue:completionHandler:");
                if (![descriptor respondsToSelector:enumSel]) continue;

                NSLog(@"[SimBridge] Trying enumerateScreens on %@", [descriptor class]);

                dispatch_semaphore_t enumSema = dispatch_semaphore_create(0);
                __block id enumScreen = nil;

                void (^completionHandler)(id, id) = ^(id screens, id enumError) {
                    NSLog(@"[SimBridge] Screen enumeration: screens=%@, error=%@", screens, enumError);
                    if ([screens isKindOfClass:[NSArray class]] && [(NSArray *)screens count] > 0) {
                        enumScreen = [(NSArray *)screens objectAtIndex:0];
                    } else if ([screens isKindOfClass:[NSDictionary class]]) {
                        enumScreen = [[(NSDictionary *)screens allValues] firstObject];
                    } else if (screens) {
                        enumScreen = screens;
                    }
                    dispatch_semaphore_signal(enumSema);
                };

                ((void (*)(id, SEL, dispatch_queue_t, id))objc_msgSend)(
                    descriptor, enumSel,
                    dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                    completionHandler
                );

                dispatch_semaphore_wait(enumSema,
                    dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)));

                if (enumScreen) {
                    NSLog(@"[SimBridge] Got screen from enumeration: %@", [enumScreen class]);
                    [screenDescriptors addObject:enumScreen];
                }
            }
        }
    }

    // ========================================================================
    // APPROACH 4: Register frame callbacks directly on screen objects
    // AND try to get IOSurface for high-speed polling
    // ========================================================================
    if (!registered && screenDescriptors.count > 0) {
        NSLog(@"[SimBridge] Trying direct frame callbacks on %lu screen(s)",
              (unsigned long)screenDescriptors.count);

        for (id screen in screenDescriptors) {
            // Try to get IOSurface from this screen for fast polling
            IOSurfaceRef surface = try_get_surface_from_screen(screen);
            if (surface) {
                bridge->currentSurface = (IOSurfaceRef)CFRetain(surface);
                bridge->screenWidth = (double)IOSurfaceGetWidth(surface);
                bridge->screenHeight = (double)IOSurfaceGetHeight(surface);
                bridge->screenObject = screen;
                NSLog(@"[SimBridge] Got IOSurface directly from screen: %zux%zu — will use fast polling",
                      IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface));
                return true;  // Will use IOSurface polling at 30fps
            }

            // Register frame callbacks (may or may not fire)
            register_frame_callbacks_on_screen(bridge, screen, NULL);
            // Don't set adapterCallbacksActive — the watchdog in
            // sim_bridge_register_frame_callback will verify if frames actually flow
        }
    }

    // If we registered frame callbacks but don't know if they work,
    // don't set adapterCallbacksActive. The watchdog will start polling
    // if frames don't arrive within 2 seconds.
    NSLog(@"[SimBridge] Setup complete — adapter callbacks not confirmed, "
           "watchdog will verify frame delivery");
    return true;
}

// ============================================================================
// MARK: - HID client setup
// ============================================================================

bool setup_hid_client(SimBridge *bridge,
                      __unused char* error_buf,
                      __unused int error_buf_len) {
    Class hidClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
    if (!hidClass) {
        hidClass = NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
    }
    if (!hidClass) {
        unsigned int classCount = 0;
        Class *classes = objc_copyClassList(&classCount);
        for (unsigned int i = 0; i < classCount; i++) {
            const char *name = class_getName(classes[i]);
            if (name && strstr(name, "LegacyHIDClient") != NULL) {
                hidClass = classes[i];
                NSLog(@"[SimBridge] Found HID class: %s", name);
                break;
            }
        }
        free(classes);
    }

    if (!hidClass) {
        NSLog(@"[SimBridge] SimDeviceLegacyHIDClient not found, touch injection disabled");
        return false;
    }

    SEL initSel = NSSelectorFromString(@"initWithDevice:error:");

    @try {
        id client = [hidClass alloc];
        if (initSel && [client respondsToSelector:initSel]) {
            NSError *initError = nil;
            client = ((id (*)(id, SEL, id, NSError**))objc_msgSend)(
                client, initSel, bridge->simDevice, &initError
            );
            if (initError) {
                NSLog(@"[SimBridge] HID client init error: %@", initError);
            }
        } else {
            SEL fallbackSel = NSSelectorFromString(@"initWithDevice:");
            if (fallbackSel && [client respondsToSelector:fallbackSel]) {
                client = ((id (*)(id, SEL, id))objc_msgSend)(
                    client, fallbackSel, bridge->simDevice
                );
            } else {
                NSLog(@"[SimBridge] No compatible HID client initializer found");
                return false;
            }
        }

        if (client) {
            bridge->hidClient = client;
            NSLog(@"[SimBridge] HID client created successfully (class=%s)", class_getName(hidClass));
            return true;
        } else {
            NSLog(@"[SimBridge] HID client init returned nil (class=%s) — touch injection disabled",
                  class_getName(hidClass));
        }
    } @catch (NSException *exception) {
        NSLog(@"[SimBridge] Failed to create HID client: %@", exception);
    }

    NSLog(@"[SimBridge] WARNING: HID client setup failed — touch/scroll/key injection will NOT work");
    return false;
}
