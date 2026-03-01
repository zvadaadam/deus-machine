#import "sim_bridge_internal.h"

// ============================================================================
// MARK: - IOSurface → JPEG encoding (CoreGraphics fallback)
// ============================================================================

NSData* iosurface_to_jpeg(IOSurfaceRef surface, float quality) {
    if (!surface) return nil;

    IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);

    size_t width = IOSurfaceGetWidth(surface);
    size_t height = IOSurfaceGetHeight(surface);
    size_t bytesPerRow = IOSurfaceGetBytesPerRow(surface);
    void* baseAddr = IOSurfaceGetBaseAddress(surface);

    if (!baseAddr || width == 0 || height == 0) {
        IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
        return nil;
    }

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    // IOSurface from simulator uses BGRA with premultiplied alpha
    CGContextRef ctx = CGBitmapContextCreate(
        baseAddr, width, height, 8, bytesPerRow,
        colorSpace,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little
    );

    if (!ctx) {
        CGColorSpaceRelease(colorSpace);
        IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
        return nil;
    }

    CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    CGColorSpaceRelease(colorSpace);
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);

    if (!cgImage) return nil;

    // Encode to JPEG
    NSMutableData *jpegData = [NSMutableData data];
    CGImageDestinationRef dest = CGImageDestinationCreateWithData(
        (__bridge CFMutableDataRef)jpegData,
        (__bridge CFStringRef)@"public.jpeg",
        1, NULL
    );

    if (!dest) {
        CGImageRelease(cgImage);
        return nil;
    }

    NSDictionary *opts = @{
        (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(quality)
    };
    CGImageDestinationAddImage(dest, cgImage, (__bridge CFDictionaryRef)opts);
    CGImageDestinationFinalize(dest);

    CFRelease(dest);
    CGImageRelease(cgImage);

    return jpegData;
}

// ============================================================================
// MARK: - VideoToolbox JPEG encoding (hardware-accelerated, persistent session)
// ============================================================================

// Per-frame callback context — carries pointer to output NSData.
// No semaphore needed: VTCompressionSessionCompleteFrames blocks until all
// output callbacks have fired, so outputData is populated when it returns.
typedef struct {
    NSData * __strong *outputData;
} VTJpegCallbackContext;

// Output callback for PERSISTENT VTCompressionSession.
// Uses sourceFrameRefCon (per-frame) instead of outputCallbackRefCon (per-session)
// so the session can be reused across frames.
static void vt_jpeg_output_callback(void *outputCallbackRefCon,
                                     void *sourceFrameRefCon,
                                     OSStatus status,
                                     VTEncodeInfoFlags infoFlags,
                                     CMSampleBufferRef sampleBuffer) {
    (void)outputCallbackRefCon; // Unused — persistent session sets this to NULL
    VTJpegCallbackContext *ctx = (VTJpegCallbackContext *)sourceFrameRefCon;
    if (!ctx) return;

    if (status != noErr || !sampleBuffer) {
        return;
    }

    // Extract JPEG data from CMSampleBuffer
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) {
        return;
    }

    size_t length = 0;
    char *dataPointer = NULL;
    OSStatus blockStatus = CMBlockBufferGetDataPointer(
        blockBuffer, 0, NULL, &length, &dataPointer);

    if (blockStatus == noErr && dataPointer && length > 0) {
        *(ctx->outputData) = [NSData dataWithBytes:dataPointer length:length];
    }
}

/**
 * Encode an IOSurface to JPEG using a PERSISTENT VTCompressionSession.
 * Session created once, reused for all frames (VTJpegEncoder pattern).
 * Only recreated when dimensions change. Falls back to CGImageDestination on failure.
 */
NSData* bridge_encode_jpeg(SimBridge *bridge, IOSurfaceRef surface, float quality) {
    if (!surface) return nil;

    int32_t width = (int32_t)IOSurfaceGetWidth(surface);
    int32_t height = (int32_t)IOSurfaceGetHeight(surface);
    if (width == 0 || height == 0) return nil;

    CachedJpegEncoder *enc = &bridge->jpegEncoder;

    // Create or recreate session if dimensions/quality changed
    if (!enc->session || enc->width != width || enc->height != height || enc->quality != quality) {
        if (enc->session) {
            VTCompressionSessionInvalidate(enc->session);
            CFRelease(enc->session);
            enc->session = NULL;
        }

        OSStatus status = VTCompressionSessionCreate(
            kCFAllocatorDefault,
            width, height,
            kCMVideoCodecType_JPEG,
            NULL,  // encoderSpecification
            NULL,  // sourceImageBufferAttributes
            kCFAllocatorDefault,
            vt_jpeg_output_callback,
            NULL,  // outputCallbackRefCon = NULL (persistent session, uses sourceFrameRefCon)
            &enc->session);

        if (status != noErr || !enc->session) {
            return iosurface_to_jpeg(surface, quality);
        }

        VTSessionSetProperty(enc->session, kVTCompressionPropertyKey_Quality,
                             (__bridge CFTypeRef)@(quality));
        // Request hardware-accelerated encoding
        VTSessionSetProperty(enc->session, kVTCompressionPropertyKey_RealTime,
                             kCFBooleanTrue);

        enc->width = width;
        enc->height = height;
        enc->quality = quality;

        NSLog(@"[SimBridge] Created persistent VTCompressionSession: %dx%d quality=%.2f (RealTime=true)",
              width, height, quality);
    }

    // Create CVPixelBuffer from IOSurface (zero-copy wrap).
    // Cache the attributes dictionary — it never changes.
    static CFDictionaryRef cachedAttrs = NULL;
    if (!cachedAttrs) {
        NSDictionary *attrs = @{
            (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{}
        };
        cachedAttrs = CFRetain((__bridge CFDictionaryRef)attrs);
    }

    CVPixelBufferRef pixelBuffer = NULL;
    CVReturn cvRet = CVPixelBufferCreateWithIOSurface(
        kCFAllocatorDefault, surface, cachedAttrs, &pixelBuffer);

    if (cvRet != kCVReturnSuccess || !pixelBuffer) {
        return iosurface_to_jpeg(surface, quality);
    }

    // Per-frame callback context (passed via sourceFrameRefCon).
    // No semaphore needed — CompleteFrames blocks until all callbacks fire.
    __block NSData *outputData = nil;
    VTJpegCallbackContext callbackCtx;
    callbackCtx.outputData = &outputData;

    // Encode — pass &callbackCtx as sourceFrameRefCon (6th param)
    CMTime presentationTime = CMTimeMake(0, 1);
    OSStatus status = VTCompressionSessionEncodeFrame(
        enc->session, pixelBuffer, presentationTime,
        kCMTimeInvalid, NULL, &callbackCtx, NULL);

    if (status != noErr) {
        CVPixelBufferRelease(pixelBuffer);
        // Session may be corrupted — destroy and let next call recreate
        VTCompressionSessionInvalidate(enc->session);
        CFRelease(enc->session);
        enc->session = NULL;
        return iosurface_to_jpeg(surface, quality);
    }

    // Block until the encoder finishes and the output callback has fired.
    // After this returns, outputData is populated (or nil on failure).
    VTCompressionSessionCompleteFrames(enc->session, kCMTimeInvalid);

    CVPixelBufferRelease(pixelBuffer);
    return outputData;
}

// ============================================================================
// MARK: - simctl-based screen capture (fallback)
// ============================================================================

NSData* capture_simctl_screenshot(NSString *udid) {
    @autoreleasepool {
        NSPipe *outputPipe = [NSPipe pipe];

        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcrun"];
        // Use "-" to write JPEG to stdout instead of a temp file
        task.arguments = @[@"simctl", @"io", udid, @"screenshot", @"--type=jpeg", @"-"];
        task.standardOutput = outputPipe;
        task.standardError = [NSPipe pipe];

        NSError *error = nil;
        [task launchAndReturnError:&error];
        if (error) {
            NSLog(@"[SimBridge] simctl launch error: %@", error);
            return nil;
        }

        // Read all JPEG data from stdout pipe
        NSData *jpegData = [[outputPipe fileHandleForReading] readDataToEndOfFile];

        [task waitUntilExit];

        if (task.terminationStatus != 0) {
            NSLog(@"[SimBridge] simctl failed with status %d", task.terminationStatus);
            return nil;
        }

        return (jpegData && jpegData.length > 0) ? jpegData : nil;
    }
}

// ============================================================================
// MARK: - JPEG resize for AI consumption
// ============================================================================

/// Resize a JPEG so the long side fits within maxLongSide pixels.
/// Uses kCGImageDestinationImageMaxPixelSize for single-pass decode+scale+encode
/// with no intermediate full-res bitmap (ImageIO tiles internally).
/// Returns the original data unchanged if already small enough or on any error.
NSData* resize_jpeg_for_ai(NSData *jpegData, size_t maxLongSide) {
    if (!jpegData || jpegData.length == 0 || maxLongSide == 0) return jpegData;

    // Peek at dimensions from JPEG header — no pixel decode
    CGImageSourceRef source = CGImageSourceCreateWithData(
        (__bridge CFDataRef)jpegData, NULL);
    if (!source) return jpegData;

    CFDictionaryRef props = CGImageSourceCopyPropertiesAtIndex(source, 0, NULL);
    if (!props) {
        CFRelease(source);
        return jpegData;
    }

    CFNumberRef wRef = CFDictionaryGetValue(props, kCGImagePropertyPixelWidth);
    CFNumberRef hRef = CFDictionaryGetValue(props, kCGImagePropertyPixelHeight);
    size_t w = 0, h = 0;
    if (wRef) CFNumberGetValue(wRef, kCFNumberSInt64Type, &w);
    if (hRef) CFNumberGetValue(hRef, kCFNumberSInt64Type, &h);
    CFRelease(props);

    size_t longSide = (w >= h) ? w : h;
    if (longSide <= maxLongSide) {
        // Already within budget — skip encode
        CFRelease(source);
        return jpegData;
    }

    // Single-pass resize+encode via ImageIO
    NSMutableData *output = [NSMutableData data];
    CGImageDestinationRef dest = CGImageDestinationCreateWithData(
        (__bridge CFMutableDataRef)output,
        (__bridge CFStringRef)@"public.jpeg",
        1, NULL);

    if (!dest) {
        CFRelease(source);
        return jpegData;
    }

    NSDictionary *opts = @{
        (id)kCGImageDestinationImageMaxPixelSize: @(maxLongSide),
        (id)kCGImageDestinationLossyCompressionQuality: @(0.5f),
    };
    CGImageDestinationAddImageFromSource(dest, source, 0,
        (__bridge CFDictionaryRef)opts);
    bool ok = CGImageDestinationFinalize(dest);

    CFRelease(dest);
    CFRelease(source);

    return (ok && output.length > 0) ? output : jpegData;
}
