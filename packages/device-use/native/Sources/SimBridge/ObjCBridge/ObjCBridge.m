#import "include/ObjCBridge.h"
#import <objc/runtime.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <malloc/malloc.h>

// =============================================================================
// Indigo HID function types (loaded from Simulator.app)
// =============================================================================

// IndigoHIDMessageForMouseNSEvent(CGPoint*, uint32, uint32, int32, uint32) -> void*
typedef void* (*IndigoMouseFunc)(CGPoint*, uint32_t, uint32_t, int32_t, uint32_t);

// IndigoHIDMessageForKeyboardArbitrary(uint32_t keycode, int direction) -> void*
typedef void* (*IndigoKeyboardFunc)(uint32_t, int32_t);

// IndigoHIDMessageForButton(int eventSource, int direction, int target) -> void*
typedef void* (*IndigoButtonFunc)(int32_t, int32_t, int32_t);

// sendWithMessage:freeWhenDone:completionQueue:completion:
typedef void (*SendMsgFunc)(id, SEL, void*, BOOL, id, id);

// sendKeyEventWithKeyCode:keyDirection:
typedef void (*SendKeyFunc)(id, SEL, uint16_t, int);

// =============================================================================
// Indigo message layout constants (from idb/FBSimulatorControl)
// =============================================================================

static const int kPayloadStride  = 0xa0;  // sizeof(IndigoPayload)
static const int kHeaderSize     = 0x20;  // Mach header
static const int kTouchOffset    = 0x10;  // IndigoTouch within IndigoPayload
static const int kTouchSize      = 0x90;  // sizeof(IndigoTouch)

// Touch event types (NSEvent types)
static const int32_t kTouchBegin = 1;  // NSEventTypeLeftMouseDown
static const int32_t kTouchEnd   = 2;  // NSEventTypeLeftMouseUp
static const int32_t kTouchMove  = 6;  // NSEventTypeLeftMouseDragged

// Button constants
static const int32_t kButtonTargetHardware = 0x33;

// =============================================================================
// Static state
// =============================================================================

static IndigoMouseFunc    sMouseFunc    = NULL;
static IndigoKeyboardFunc sKeyboardFunc = NULL;
static IndigoButtonFunc   sButtonFunc   = NULL;
static BOOL               sFuncsLoaded  = NO;

static void loadIndigoFunctions(void) {
    if (sFuncsLoaded) return;
    sFuncsLoaded = YES;

    // IndigoHID functions live in Simulator.app's binary
    void *h = RTLD_DEFAULT;

    sMouseFunc = (IndigoMouseFunc)dlsym(h, "IndigoHIDMessageForMouseNSEvent");
    if (sMouseFunc) {
        fprintf(stderr, "[simbridge-objc] IndigoHIDMessageForMouseNSEvent loaded\n");
    }

    sKeyboardFunc = (IndigoKeyboardFunc)dlsym(h, "IndigoHIDMessageForKeyboardArbitrary");
    if (sKeyboardFunc) {
        fprintf(stderr, "[simbridge-objc] IndigoHIDMessageForKeyboardArbitrary loaded\n");
    }

    sButtonFunc = (IndigoButtonFunc)dlsym(h, "IndigoHIDMessageForButton");
    if (sButtonFunc) {
        fprintf(stderr, "[simbridge-objc] IndigoHIDMessageForButton loaded\n");
    }
}

// =============================================================================
// AXPTranslator Dispatcher (implements AXPTranslationTokenDelegateHelper)
// Must be declared before SimAccessibilityBridge since it's used in accessibility methods.
// =============================================================================

@interface AXPDispatcher : NSObject {
    NSMutableDictionary<NSString *, id> *_tokenToDevice;
    dispatch_queue_t _callbackQueue;
}
- (void)registerDevice:(id)device forToken:(NSString *)token;
- (void)unregisterToken:(NSString *)token;
@end

@implementation AXPDispatcher

- (instancetype)init {
    self = [super init];
    if (self) {
        _tokenToDevice = [NSMutableDictionary dictionary];
        _callbackQueue = dispatch_queue_create("simbridge.axp.callback", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)registerDevice:(id)device forToken:(NSString *)token {
    @synchronized(self) {
        _tokenToDevice[token] = device;
    }
}

- (void)unregisterToken:(NSString *)token {
    @synchronized(self) {
        [_tokenToDevice removeObjectForKey:token];
    }
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"

- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
    id device;
    @synchronized(self) {
        device = _tokenToDevice[token];
    }

    if (!device) {
        return ^id(id axRequest) {
            return [NSClassFromString(@"AXPTranslatorResponse") performSelector:NSSelectorFromString(@"emptyResponse")];
        };
    }

    dispatch_queue_t cbQueue = _callbackQueue;

    return ^id(id axRequest) {
        SEL sel = NSSelectorFromString(@"sendAccessibilityRequestAsync:completionQueue:completionHandler:");
        NSMethodSignature *sig = [device methodSignatureForSelector:sel];
        if (!sig) {
            return [NSClassFromString(@"AXPTranslatorResponse") performSelector:NSSelectorFromString(@"emptyResponse")];
        }

        dispatch_group_t group = dispatch_group_create();
        dispatch_group_enter(group);
        __block id response = nil;

        NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
        [inv setTarget:device];
        [inv setSelector:sel];
        [inv setArgument:&axRequest atIndex:2];
        [inv setArgument:&cbQueue atIndex:3];

        void (^handler)(id) = ^(id innerResponse) {
            response = innerResponse;
            dispatch_group_leave(group);
        };
        [inv setArgument:&handler atIndex:4];
        [inv retainArguments];
        [inv invoke];

        dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC);
        dispatch_group_wait(group, timeout);

        if (!response) {
            return [NSClassFromString(@"AXPTranslatorResponse") performSelector:NSSelectorFromString(@"emptyResponse")];
        }
        return response;
    };
}

#pragma clang diagnostic pop

- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect withToken:(NSString *)token {
    return rect;
}

- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
    return nil;
}

@end

// =============================================================================
// AXPTranslator Singleton Setup
// =============================================================================

static id sTranslator = nil;
static AXPDispatcher *sDispatcher = nil;

static void ensureAXPTranslatorSetup(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW);

        Class translatorClass = NSClassFromString(@"AXPTranslator");
        if (!translatorClass) {
            fprintf(stderr, "[simbridge] AXPTranslator class not found\n");
            return;
        }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        sTranslator = [translatorClass performSelector:NSSelectorFromString(@"sharedInstance")];
#pragma clang diagnostic pop

        if (!sTranslator) {
            fprintf(stderr, "[simbridge] AXPTranslator.sharedInstance returned nil\n");
            return;
        }

        sDispatcher = [[AXPDispatcher alloc] init];
        [sTranslator setValue:sDispatcher forKey:@"bridgeTokenDelegate"];
        [sTranslator setValue:@YES forKey:@"supportsDelegateTokens"];

        fprintf(stderr, "[simbridge] AXPTranslator configured with bridge delegate\n");
    });
}

// =============================================================================
// Element Serialization
// =============================================================================

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"

static NSDictionary *serializeAccessibilityElement(id element, NSString *token, int depth) {
    if (!element || depth > 30) return nil;

    @try {
        id translation = [element valueForKey:@"translation"];
        if (translation) {
            [translation setValue:token forKey:@"bridgeDelegateToken"];
        }
    } @catch (NSException *e) {}

    NSMutableDictionary *dict = [NSMutableDictionary dictionary];

    @try {
        NSString *role = [element performSelector:NSSelectorFromString(@"accessibilityRole")];
        dict[@"AXRole"] = role ?: @"Unknown";
    } @catch (NSException *e) {
        dict[@"AXRole"] = @"Unknown";
    }

    @try {
        NSString *label = [element performSelector:NSSelectorFromString(@"accessibilityLabel")];
        if (label.length > 0) dict[@"AXLabel"] = label;
    } @catch (NSException *e) {}

    @try {
        id value = [element performSelector:NSSelectorFromString(@"accessibilityValue")];
        if (value && value != [NSNull null]) dict[@"AXValue"] = [value description];
    } @catch (NSException *e) {}

    @try {
        NSString *identifier = [element performSelector:NSSelectorFromString(@"accessibilityIdentifier")];
        if (identifier.length > 0) dict[@"AXUniqueId"] = identifier;
    } @catch (NSException *e) {}

    @try {
        dict[@"AXEnabled"] = @YES;
        if ([element respondsToSelector:NSSelectorFromString(@"isAccessibilityEnabled")]) {
            BOOL enabled = ((BOOL (*)(id, SEL))objc_msgSend)(element, NSSelectorFromString(@"isAccessibilityEnabled"));
            dict[@"AXEnabled"] = @(enabled);
        }
    } @catch (NSException *e) {}

    @try {
        SEL frameSel = NSSelectorFromString(@"accessibilityFrame");
        NSMethodSignature *frameSig = [element methodSignatureForSelector:frameSel];
        if (frameSig) {
            NSInvocation *frameInv = [NSInvocation invocationWithMethodSignature:frameSig];
            [frameInv setTarget:element];
            [frameInv setSelector:frameSel];
            [frameInv invoke];
            CGRect frame;
            [frameInv getReturnValue:&frame];
            dict[@"frame"] = @{
                @"x": @(frame.origin.x),
                @"y": @(frame.origin.y),
                @"width": @(frame.size.width),
                @"height": @(frame.size.height),
            };
        }
    } @catch (NSException *e) {
        dict[@"frame"] = @{@"x": @0, @"y": @0, @"width": @0, @"height": @0};
    }

    NSMutableArray *childDicts = [NSMutableArray array];
    @try {
        NSArray *children = [element performSelector:NSSelectorFromString(@"accessibilityChildren")];
        for (id child in children) {
            NSDictionary *childDict = serializeAccessibilityElement(child, token, depth + 1);
            if (childDict) {
                [childDicts addObject:childDict];
            }
        }
    } @catch (NSException *e) {}
    dict[@"children"] = childDicts;

    return dict;
}

#pragma clang diagnostic pop

// =============================================================================
// Implementation
// =============================================================================

@implementation SimAccessibilityBridge

+ (void)ensureSimulatorKitLoaded {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
        task.arguments = @[@"-p"];
        NSPipe *pipe = [NSPipe pipe];
        task.standardOutput = pipe;
        task.standardError = [NSFileHandle fileHandleWithNullDevice];
        @try {
            [task launch];
            [task waitUntilExit];
        } @catch (NSException *e) {
            return;
        }
        NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
        NSString *devDir = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        devDir = [devDir stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!devDir.length) return;

        dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);

        NSString *simKitPath = [NSString stringWithFormat:@"%@/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", devDir];
        dlopen(simKitPath.UTF8String, RTLD_NOW);

        // Also try loading from Simulator.app for Indigo functions
        NSString *simAppPath = [NSString stringWithFormat:@"%@/../Applications/Simulator.app/Contents/MacOS/Simulator", devDir];
        dlopen(simAppPath.UTF8String, RTLD_NOW);

        loadIndigoFunctions();
    });
}

#pragma mark - HID Client Creation

+ (nullable id)createHIDClientForDevice:(id)device error:(NSError **)error {
    [self ensureSimulatorKitLoaded];

    // Try the Swift-mangled name first (Xcode 15+), then plain name
    Class hidClass = NSClassFromString(@"_TtC12SimulatorKit24SimDeviceLegacyHIDClient")
                  ?: NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient")
                  ?: NSClassFromString(@"SimDeviceLegacyHIDClient");

    if (!hidClass) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:3
                                     userInfo:@{NSLocalizedDescriptionKey: @"SimDeviceLegacyHIDClient class not found"}];
        }
        return nil;
    }

    SEL initSel = NSSelectorFromString(@"initWithDevice:error:");
    IMP initIMP = class_getMethodImplementation(hidClass, initSel);
    if (!initIMP) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:4
                                     userInfo:@{NSLocalizedDescriptionKey: @"initWithDevice:error: not found"}];
        }
        return nil;
    }

    typedef id (*HIDInitFunc)(id, SEL, id, NSError **);
    HIDInitFunc initFunc = (HIDInitFunc)initIMP;

    NSError *initErr = nil;
    id client = initFunc([hidClass alloc], initSel, device, &initErr);
    if (!client || initErr) {
        if (error) *error = initErr ?: [NSError errorWithDomain:@"SimHelper" code:4
                                                       userInfo:@{NSLocalizedDescriptionKey: @"Failed to create HID client"}];
        return nil;
    }

    return client;
}

#pragma mark - Accessibility (AXPTranslator-based)

+ (nullable id)fetchAccessibilityFromDevice:(id)device error:(NSError **)error {
    ensureAXPTranslatorSetup();

    if (!sTranslator || !sDispatcher) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:10
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"AXPTranslator not available. AccessibilityPlatformTranslation.framework not loaded."}];
        }
        return nil;
    }

    SEL asyncSel = NSSelectorFromString(@"sendAccessibilityRequestAsync:completionQueue:completionHandler:");
    if (![device respondsToSelector:asyncSel]) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:10
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"Device does not respond to sendAccessibilityRequestAsync (requires Xcode 12+)"}];
        }
        return nil;
    }

    NSString *token = [[NSUUID UUID] UUIDString];
    [sDispatcher registerDevice:device forToken:token];

    @try {
        // Step 1: Get frontmost application translation
        SEL frontmostSel = NSSelectorFromString(@"frontmostApplicationWithDisplayId:bridgeDelegateToken:");
        NSMethodSignature *fmSig = [sTranslator methodSignatureForSelector:frontmostSel];
        if (!fmSig) {
            [sDispatcher unregisterToken:token];
            if (error) {
                *error = [NSError errorWithDomain:@"SimHelper" code:10
                                         userInfo:@{NSLocalizedDescriptionKey:
                    @"AXPTranslator missing frontmostApplicationWithDisplayId:bridgeDelegateToken:"}];
            }
            return nil;
        }

        NSInvocation *fmInv = [NSInvocation invocationWithMethodSignature:fmSig];
        [fmInv setTarget:sTranslator];
        [fmInv setSelector:frontmostSel];
        unsigned int displayId = 0;
        [fmInv setArgument:&displayId atIndex:2];
        [fmInv setArgument:&token atIndex:3];
        [fmInv retainArguments];
        [fmInv invoke];

        id __unsafe_unretained translation = nil;
        [fmInv getReturnValue:&translation];

        if (!translation) {
            [sDispatcher unregisterToken:token];
            if (error) {
                *error = [NSError errorWithDomain:@"SimHelper" code:10
                                         userInfo:@{NSLocalizedDescriptionKey:
                    @"No frontmost application found. Ensure the simulator has a running app."}];
            }
            return nil;
        }

        // Step 2: Convert to platform element
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
        SEL convertSel = NSSelectorFromString(@"macPlatformElementFromTranslation:");
        id element = [sTranslator performSelector:convertSel withObject:translation];
#pragma clang diagnostic pop

        if (!element) {
            [sDispatcher unregisterToken:token];
            if (error) {
                *error = [NSError errorWithDomain:@"SimHelper" code:10
                                         userInfo:@{NSLocalizedDescriptionKey:
                    @"Failed to convert translation to platform element"}];
            }
            return nil;
        }

        // Step 3: Set bridgeDelegateToken on element's translation
        @try {
            id elemTranslation = [element valueForKey:@"translation"];
            if (elemTranslation) {
                [elemTranslation setValue:token forKey:@"bridgeDelegateToken"];
            }
        } @catch (NSException *e) {}

        // Step 4: Recursively serialize the element tree
        NSDictionary *tree = serializeAccessibilityElement(element, token, 0);

        [sDispatcher unregisterToken:token];

        if (tree) {
            return @[tree];
        }

        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:10
                                     userInfo:@{NSLocalizedDescriptionKey: @"Serialization returned nil"}];
        }
        return nil;

    } @catch (NSException *e) {
        [sDispatcher unregisterToken:token];
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:10
                                     userInfo:@{NSLocalizedDescriptionKey:
                [NSString stringWithFormat:@"Accessibility fetch exception: %@", e.reason]}];
        }
        return nil;
    }
}

#pragma mark - Touch Events

+ (BOOL)sendTouchToDevice:(id)device
                        x:(double)x
                        y:(double)y
                   isDown:(BOOL)isDown
                    error:(NSError **)error {
    int32_t eventType = isDown ? kTouchBegin : kTouchEnd;
    return [self sendTouchToDevice:device x:x y:y eventType:eventType error:error];
}

+ (BOOL)sendTouchToDevice:(id)device
                        x:(double)x
                        y:(double)y
                eventType:(int32_t)eventType
                    error:(NSError **)error {
    [self ensureSimulatorKitLoaded];

    NSError *clientErr = nil;
    id client = [self createHIDClientForDevice:device error:&clientErr];
    if (!client) {
        if (error) *error = clientErr;
        return NO;
    }

    SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");

    // =========================================================================
    // Strategy 1: IndigoHIDMessageForMouseNSEvent (proven by radon/sim-stream)
    // =========================================================================
    if (sMouseFunc) {
        CGPoint point = CGPointMake(x, y);

        // Create raw IndigoMessage via the C function
        void *rawMsg = sMouseFunc(&point, 0, 0x32, eventType, 0);
        if (!rawMsg) {
            if (error) {
                *error = [NSError errorWithDomain:@"SimHelper" code:5
                                         userInfo:@{NSLocalizedDescriptionKey:
                    @"IndigoHIDMessageForMouseNSEvent returned NULL"}];
            }
            return NO;
        }

        // Patch xRatio and yRatio on the raw message for normalized coordinates
        // xRatio at absolute offset 0x3C, yRatio at 0x44
        ((uint8_t *)rawMsg)[0x3C] = 0; // Clear existing
        memcpy(rawMsg + 0x3C, &x, sizeof(double));
        memcpy(rawMsg + 0x44, &y, sizeof(double));

        // Extract touch data from raw message
        void *touchDataPtr = rawMsg + 0x30;

        // Build properly-structured dual-payload message (idb's format)
        int totalSize = kHeaderSize + kPayloadStride * 2;
        void *msg = calloc(1, totalSize);

        // Header
        *(uint32_t *)(msg + 0x18) = (uint32_t)kPayloadStride;  // innerSize
        *(uint8_t *)(msg + 0x1C) = 2;                           // eventType = touch

        // First payload
        int p1 = kHeaderSize;
        *(uint32_t *)(msg + p1) = 0x0b;                                    // payloadType = digitizer
        *(uint64_t *)(msg + p1 + 0x04) = mach_absolute_time();             // timestamp
        memcpy(msg + p1 + kTouchOffset, touchDataPtr, kTouchSize);         // touch data

        // Second payload = copy of first, then override event fields
        int p2 = p1 + kPayloadStride;
        memcpy(msg + p2, msg + p1, kPayloadStride);
        *(uint32_t *)(msg + p2 + kTouchOffset) = 1;
        *(uint32_t *)(msg + p2 + kTouchOffset + 4) = 2;

        free(rawMsg);

        // Send via SimDeviceLegacyHIDClient
        IMP sendIMP = class_getMethodImplementation(object_getClass(client), sendSel);
        if (sendIMP) {
            SendMsgFunc sendFunc = (SendMsgFunc)sendIMP;
            sendFunc(client, sendSel, msg, YES, nil, nil);
            return YES;
        }
        free(msg);
    }

    // =========================================================================
    // Strategy 2: sendPurpleEvent: on SimDevice (legacy fallback)
    // =========================================================================
    if (sMouseFunc) {
        SEL purpleSel = NSSelectorFromString(@"sendPurpleEvent:");
        if ([device respondsToSelector:purpleSel]) {
            CGPoint point = CGPointMake(x, y);
            void *rawMsg = sMouseFunc(&point, 0, 0x32, eventType, 0);
            if (rawMsg) {
                size_t msgSize = malloc_size(rawMsg);
                NSData *eventData = [NSData dataWithBytesNoCopy:rawMsg length:msgSize freeWhenDone:YES];
                @try {
                    ((void (*)(id, SEL, id))objc_msgSend)(device, purpleSel, eventData);
                    return YES;
                } @catch (NSException *e) {
                    // Fall through
                }
            }
        }
    }

    if (error) {
        *error = [NSError errorWithDomain:@"SimHelper" code:5
                                 userInfo:@{NSLocalizedDescriptionKey:
            @"No touch method available. IndigoHIDMessageForMouseNSEvent not loaded."}];
    }
    return NO;
}

#pragma mark - Tap Gesture (single-client sequence)

+ (BOOL)sendTapToDevice:(id)device
                       x:(double)x
                       y:(double)y
            holdDuration:(double)holdDuration
                   error:(NSError **)error {
    [self ensureSimulatorKitLoaded];

    if (!sMouseFunc) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:5
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"IndigoHIDMessageForMouseNSEvent not loaded."}];
        }
        return NO;
    }

    NSError *clientErr = nil;
    id client = [self createHIDClientForDevice:device error:&clientErr];
    if (!client) {
        if (error) *error = clientErr;
        return NO;
    }

    SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
    IMP sendIMP = class_getMethodImplementation(object_getClass(client), sendSel);
    if (!sendIMP) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:5
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"sendWithMessage: not available on HID client"}];
        }
        return NO;
    }

    SendMsgFunc sendFunc = (SendMsgFunc)sendIMP;
    __block BOOL eventFailed = NO;

    // Helper block: build and send a touch event of the given type
    BOOL (^sendEvent)(int32_t) = ^BOOL(int32_t eventType) {
        CGPoint point = CGPointMake(x, y);
        void *rawMsg = sMouseFunc(&point, 0, 0x32, eventType, 0);
        if (!rawMsg) return NO;

        // Patch normalized coordinates
        memcpy(rawMsg + 0x3C, &x, sizeof(double));
        memcpy(rawMsg + 0x44, &y, sizeof(double));

        void *touchDataPtr = rawMsg + 0x30;

        int totalSize = kHeaderSize + kPayloadStride * 2;
        void *msg = calloc(1, totalSize);
        if (!msg) { free(rawMsg); return NO; }

        // Header
        *(uint32_t *)(msg + 0x18) = (uint32_t)kPayloadStride;
        *(uint8_t *)(msg + 0x1C) = 2;  // eventType = touch

        // Payload 1
        int p1 = kHeaderSize;
        *(uint32_t *)(msg + p1) = 0x0b;  // payloadType = digitizer
        *(uint64_t *)(msg + p1 + 0x04) = mach_absolute_time();
        memcpy(msg + p1 + kTouchOffset, touchDataPtr, kTouchSize);

        // Payload 2
        int p2 = p1 + kPayloadStride;
        memcpy(msg + p2, msg + p1, kPayloadStride);
        *(uint32_t *)(msg + p2 + kTouchOffset) = 1;
        *(uint32_t *)(msg + p2 + kTouchOffset + 4) = 2;

        free(rawMsg);

        sendFunc(client, sendSel, msg, YES, nil, nil);
        return YES;
    };

    // --- Complete tap gesture on a SINGLE HID client ---

    // 1. Touch begin
    if (!sendEvent(kTouchBegin)) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:5
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"Tap touch-begin failed: IndigoHID returned NULL"}];
        }
        return NO;
    }

    // 2. Brief pause, then intermediate move (matches real finger behavior)
    usleep((useconds_t)(holdDuration * 0.3 * 1e6));
    sendEvent(kTouchMove);  // move failure is non-fatal

    // 3. Hold for remaining duration
    usleep((useconds_t)(holdDuration * 0.7 * 1e6));

    // 4. Touch end
    if (!sendEvent(kTouchEnd)) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:5
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"Tap touch-end failed: IndigoHID returned NULL"}];
        }
        return NO;
    }

    return YES;
}

#pragma mark - Button Events

+ (BOOL)sendButtonToDevice:(id)device
                    button:(NSString *)button
                     error:(NSError **)error {
    [self ensureSimulatorKitLoaded];

    if (!sButtonFunc) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:7
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"IndigoHIDMessageForButton not available"}];
        }
        return NO;
    }

    NSError *clientErr = nil;
    id client = [self createHIDClientForDevice:device error:&clientErr];
    if (!client) {
        if (error) *error = clientErr;
        return NO;
    }

    // Map button names to IndigoHID source constants
    int32_t buttonSource;
    if ([button isEqualToString:@"home"]) {
        buttonSource = 0x0;
    } else if ([button isEqualToString:@"lock"]) {
        buttonSource = 0x1;
    } else if ([button isEqualToString:@"volumeUp"]) {
        buttonSource = 0xbb8;
    } else if ([button isEqualToString:@"volumeDown"]) {
        buttonSource = 0xbb8;
    } else {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:7
                                     userInfo:@{NSLocalizedDescriptionKey:
                [NSString stringWithFormat:@"Unknown button: %@", button]}];
        }
        return NO;
    }

    SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
    IMP sendIMP = class_getMethodImplementation(object_getClass(client), sendSel);
    if (!sendIMP) {
        if (error) {
            *error = [NSError errorWithDomain:@"SimHelper" code:7
                                     userInfo:@{NSLocalizedDescriptionKey:
                @"sendWithMessage: not available on HID client"}];
        }
        return NO;
    }

    SendMsgFunc sendFunc = (SendMsgFunc)sendIMP;
    int32_t target = 0x33; // kButtonTargetHardware

    // Button down
    void *downMsg = sButtonFunc(buttonSource, 1, target);
    if (downMsg) {
        sendFunc(client, sendSel, downMsg, YES, nil, nil);
    }

    // Small delay between down and up
    usleep(50000); // 50ms

    // Button up
    void *upMsg = sButtonFunc(buttonSource, 2, target);
    if (upMsg) {
        sendFunc(client, sendSel, upMsg, YES, nil, nil);
    }

    return YES;
}

#pragma mark - Keyboard Events

+ (BOOL)sendKeyToDevice:(id)device
                keyCode:(NSInteger)keyCode
                 isDown:(BOOL)isDown
                  error:(NSError **)error {
    [self ensureSimulatorKitLoaded];

    NSError *clientErr = nil;
    id client = [self createHIDClientForDevice:device error:&clientErr];
    if (!client) {
        if (error) *error = clientErr;
        return NO;
    }

    int direction = isDown ? 1 : 2;  // 1=down, 2=up

    // =========================================================================
    // Strategy 1: sendKeyEventWithKeyCode:keyDirection: on HID client
    // =========================================================================
    SEL keySel = NSSelectorFromString(@"sendKeyEventWithKeyCode:keyDirection:");
    if ([client respondsToSelector:keySel]) {
        @try {
            ((SendKeyFunc)objc_msgSend)(client, keySel, (uint16_t)keyCode, direction);
            return YES;
        } @catch (NSException *e) {
            // Fall through to IndigoHID
        }
    }

    // =========================================================================
    // Strategy 2: IndigoHIDMessageForKeyboardArbitrary + sendWithMessage:
    // =========================================================================
    if (sKeyboardFunc) {
        void *msg = sKeyboardFunc((uint32_t)keyCode, direction);
        if (msg) {
            SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
            IMP sendIMP = class_getMethodImplementation(object_getClass(client), sendSel);
            if (sendIMP) {
                SendMsgFunc sendFunc = (SendMsgFunc)sendIMP;
                sendFunc(client, sendSel, msg, YES, nil, nil);
                return YES;
            }
            free(msg);
        }
    }

    // =========================================================================
    // Strategy 3: sendPurpleEvent: on device (legacy)
    // =========================================================================
    if (sKeyboardFunc) {
        SEL purpleSel = NSSelectorFromString(@"sendPurpleEvent:");
        if ([device respondsToSelector:purpleSel]) {
            void *msg = sKeyboardFunc((uint32_t)keyCode, direction);
            if (msg) {
                size_t msgSize = malloc_size(msg);
                NSData *eventData = [NSData dataWithBytesNoCopy:msg length:msgSize freeWhenDone:YES];
                @try {
                    ((void (*)(id, SEL, id))objc_msgSend)(device, purpleSel, eventData);
                    return YES;
                } @catch (NSException *e) {
                    // Fall through
                }
            }
        }
    }

    if (error) {
        *error = [NSError errorWithDomain:@"SimHelper" code:6
                                 userInfo:@{NSLocalizedDescriptionKey:
            @"No keyboard method available. Neither sendKeyEventWithKeyCode: nor IndigoHIDMessageForKeyboardArbitrary found."}];
    }
    return NO;
}

@end
