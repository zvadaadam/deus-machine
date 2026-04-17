import Foundation
import CoreVideo
import CoreMedia
import CoreGraphics
import IOSurface
import ObjectiveC

/// Headless simulator frame capture via direct IOSurface access.
///
/// Uses SimulatorKit frame callbacks (via objc_msgSend on the IO port descriptor)
/// for event-driven capture with zero jitter. Maintains a 5fps idle floor
/// for late-joining clients.
///
/// Pipeline: IOSurface (shared memory) → CVPixelBuffer (zero-copy) → JPEG encode
final class FrameCapture {
    private var onFrame: ((CVPixelBuffer, CMTime) -> Void)?
    private var frameCount: UInt64 = 0
    private(set) var capturedWidth: Int = 0
    private(set) var capturedHeight: Int = 0
    private var idleTimer: DispatchSourceTimer?
    private let captureQueue = DispatchQueue(label: "frame-capture", qos: .userInteractive)
    private var lastCaptureTimeMs: UInt64 = 0
    private var lastSeed: UInt32 = 0
    private static let idleIntervalMs: UInt64 = 200

    private var descriptor: NSObject?
    private var ioClient: NSObject?
    private var callbackUUID: NSUUID?

    /// Start capturing frames from a booted simulator device.
    /// Frameworks must already be loaded via FrameworkLoader before calling this.
    func start(device: NSObject, onFrame: @escaping (CVPixelBuffer, CMTime) -> Void) throws {
        self.onFrame = onFrame

        let state = device.value(forKey: "stateString") as? String ?? "unknown"
        guard state == "Booted" else {
            throw SimError.deviceNotBooted("Device not booted (state: \(state))")
        }

        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw SimError.unknown("Failed to get device IO")
        }
        io.perform(NSSelectorFromString("updateIOPorts"))
        self.ioClient = io

        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw SimError.unknown("Failed to get IO ports")
        }

        var mainDescriptor: NSObject?
        let pidSel = NSSelectorFromString("portIdentifier")
        let descSel = NSSelectorFromString("descriptor")
        let surfSel = NSSelectorFromString("framebufferSurface")
        for port in ports {
            guard port.responds(to: pidSel),
                  let pid = port.perform(pidSel)?.takeUnretainedValue(),
                  "\(pid)" == "com.apple.framebuffer.display",
                  port.responds(to: descSel),
                  let desc = port.perform(descSel)?.takeUnretainedValue() as? NSObject else { continue }
            // Validate this descriptor actually has a live framebufferSurface
            // (Xcode 26+ can have multiple framebuffer.display ports, not all with valid surfaces)
            guard desc.responds(to: surfSel),
                  desc.perform(surfSel)?.takeUnretainedValue() != nil else { continue }
            mainDescriptor = desc
            break
        }

        guard let desc = mainDescriptor else {
            throw SimError.unknown("No framebuffer display with valid surface found")
        }
        self.descriptor = desc

        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else {
            throw SimError.unknown("framebufferSurface returned nil (is the device booted?)")
        }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)
        capturedWidth = IOSurfaceGetWidth(surface)
        capturedHeight = IOSurfaceGetHeight(surface)
        log("[capture] Framebuffer: \(capturedWidth)x\(capturedHeight) (direct IOSurface, zero-copy)")

        try registerFrameCallbacks(desc: desc)
        captureFrameInternal(forceSend: false)
        startIdleTimer()
        log("[capture] Frame callbacks registered (event-driven) + 5fps idle floor")
    }

    // MARK: - Frame callbacks via objc_msgSend

    private func registerFrameCallbacks(desc: NSObject) throws {
        let regSel = NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")
        guard desc.responds(to: regSel) else {
            throw SimError.unknown("Descriptor doesn't support registerScreenCallbacks")
        }

        guard let msgSendPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
            throw SimError.unknown("objc_msgSend not found")
        }

        typealias MsgSendFunc = @convention(c) (
            AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject
        ) -> Void
        let msgSend = unsafeBitCast(msgSendPtr, to: MsgSendFunc.self)

        let uuid = NSUUID()
        self.callbackUUID = uuid

        let frameCallback: @convention(block) () -> Void = { [weak self] in
            self?.captureQueue.async { self?.captureFrameInternal(forceSend: false) }
        }
        let surfacesCallback: @convention(block) () -> Void = { [weak self] in
            self?.captureQueue.async { self?.captureFrameInternal(forceSend: false) }
        }
        let propsCallback: @convention(block) () -> Void = {}

        msgSend(
            desc, regSel,
            uuid, captureQueue as AnyObject,
            frameCallback as AnyObject, surfacesCallback as AnyObject, propsCallback as AnyObject
        )
    }

    private func startIdleTimer() {
        let timer = DispatchSource.makeTimerSource(queue: captureQueue)
        timer.schedule(deadline: .now().advanced(by: .milliseconds(Int(Self.idleIntervalMs))),
                       repeating: .milliseconds(Int(Self.idleIntervalMs)))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let nowMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
            if (nowMs - self.lastCaptureTimeMs) >= Self.idleIntervalMs {
                // Bypass seed check for idle floor (late joiners on static screens)
                self.captureFrameInternal(forceSend: true)
            }
        }
        timer.resume()
        self.idleTimer = timer
    }

    private func captureFrameInternal(forceSend: Bool) {
        guard let desc = descriptor else { return }

        let surfSel = NSSelectorFromString("framebufferSurface")
        guard let surfObj = desc.perform(surfSel)?.takeUnretainedValue() else { return }
        let surface = unsafeBitCast(surfObj, to: IOSurface.self)

        // Skip encoding if the surface hasn't changed (unless forced)
        let seed = IOSurfaceGetSeed(surface)
        if !forceSend && seed == lastSeed { return }
        lastSeed = seed

        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        guard w > 0, h > 0 else { return }

        if capturedWidth != w || capturedHeight != h {
            capturedWidth = w
            capturedHeight = h
            log("[capture] Surface size changed: \(w)x\(h)")
        }

        var pixelBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault, surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pb = pixelBuffer?.takeRetainedValue() else { return }

        lastCaptureTimeMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
        frameCount += 1
        let timestamp = CMTime(value: CMTimeValue(frameCount), timescale: 60)
        onFrame?(pb, timestamp)
    }

    func getScreenSize() -> (width: Int, height: Int)? {
        guard capturedWidth > 0, capturedHeight > 0 else { return nil }
        return (capturedWidth, capturedHeight)
    }

    func stop() {
        idleTimer?.cancel()
        idleTimer = nil

        if let uuid = callbackUUID, let desc = descriptor {
            let unregSel = NSSelectorFromString("unregisterScreenCallbacksWithUUID:")
            if desc.responds(to: unregSel) {
                desc.perform(unregSel, with: uuid)
            }
        }
        callbackUUID = nil
        descriptor = nil
        ioClient = nil
    }
}
