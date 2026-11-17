import Foundation
import CoreVideo
import AppKit
import ObjCBridge

/// Entry point for `--stream` mode.
/// Runs a long-lived MJPEG + WebSocket server for real-time simulator screen streaming.
enum StreamMain {

    static func run(args: [String]) -> Never {
        // Force unbuffered output
        setbuf(stdout, nil)
        setbuf(stderr, nil)

        // Ignore SIGPIPE: the parent may close our stdout/stderr pipes, and a
        // write to a closed pipe would otherwise kill the process.
        signal(SIGPIPE, SIG_IGN)

        // Initialize AppKit (needed for HID touch events)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        // Parse arguments: --stream --udid <UDID> [--port <PORT>] (0, the default: any free port)
        var udid: String?
        var port: UInt16 = 0

        var i = 0
        while i < args.count {
            switch args[i] {
            case "--udid":
                if i + 1 < args.count { udid = args[i + 1]; i += 1 }
            case "--port":
                if i + 1 < args.count, let p = UInt16(args[i + 1]) { port = p; i += 1 }
            default:
                break
            }
            i += 1
        }

        guard let deviceUDID = udid else {
            FileHandle.standardError.write(Data("Error: --udid is required for streaming mode\n".utf8))
            exit(1)
        }
        // The token every request must carry. From the environment, not argv,
        // which other users of this computer can read.
        guard let token = ProcessInfo.processInfo.environment["SIMBRIDGE_STREAM_TOKEN"], token.count >= 32 else {
            FileHandle.standardError.write(Data("Error: SIMBRIDGE_STREAM_TOKEN (at least 32 characters) is required for streaming mode\n".utf8))
            exit(1)
        }

        log("[stream] Starting simulator screen streaming")
        log("[stream] Device UDID: \(deviceUDID)")

        // Load frameworks
        do {
            try FrameworkLoader.shared.loadAll()
        } catch {
            FileHandle.standardError.write(Data("Error: \(error)\n".utf8))
            exit(1)
        }

        // Find device
        let device: NSObject
        do {
            device = try DeviceLookup.findDevice(udid: deviceUDID)
        } catch {
            FileHandle.standardError.write(Data("Error: \(error)\n".utf8))
            exit(1)
        }

        // Create components
        let streamServer = StreamServer(token: token)
        let frameCapture = FrameCapture()
        let videoEncoder = VideoEncoder(quality: 0.7)
        let encodeQueue = DispatchQueue(label: "encode", qos: .userInteractive)

        var screenWidth = 0
        var screenHeight = 0
        var encoderReady = false
        let encodingSemaphore = DispatchSemaphore(value: 1)  // backpressure: 1 frame at a time

        // Wire touch input: WebSocket → ObjC HID bridge
        streamServer.clientManager.onTouch = { touch in
            // Touch coordinates arrive normalized [0, 1] — the ObjC bridge expects them this way
            let eventType: Int32
            switch touch.type {
            case "begin": eventType = 1   // NSEventTypeLeftMouseDown
            case "move":  eventType = 6   // NSEventTypeLeftMouseDragged
            case "end":   eventType = 2   // NSEventTypeLeftMouseUp
            default: return
            }
            do {
                try SimAccessibilityBridge.sendTouch(toDevice: device, x: touch.x, y: touch.y, eventType: eventType)
            } catch {
                log("[touch] Error: \(error.localizedDescription)")
            }
        }

        // Wire button input: WebSocket → HID bridge
        streamServer.clientManager.onButton = { button in
            do {
                try SimAccessibilityBridge.sendButton(toDevice: device, button: button)
            } catch {
                log("[button] Error: \(error.localizedDescription)")
            }
        }

        // Wire key input: WebSocket → HID bridge, one direction per message
        streamServer.clientManager.onKey = { key in
            do {
                try SimAccessibilityBridge.sendKey(toDevice: device, keyCode: key.keyCode, isDown: key.direction == "down")
            } catch {
                log("[key] Error: \(error.localizedDescription)")
            }
        }

        // Start HTTP + WebSocket server
        let boundPort: Int
        do {
            boundPort = try streamServer.start(port: port)
        } catch {
            FileHandle.standardError.write(Data("Error starting server: \(error)\n".utf8))
            exit(1)
        }

        // Start frame capture with lazy encoder initialization
        do {
            try frameCapture.start(device: device) { pixelBuffer, timestamp in
                let w = CVPixelBufferGetWidth(pixelBuffer)
                let h = CVPixelBufferGetHeight(pixelBuffer)

                // Initialize encoder on first frame (or resolution change)
                if !encoderReady || w != screenWidth || h != screenHeight {
                    screenWidth = w
                    screenHeight = h
                    log("[stream] Frame dimensions: \(w)x\(h), (re)initializing encoder")

                    videoEncoder.stop()
                    videoEncoder.setup(
                        onEncodedFrame: { jpegData in
                            streamServer.clientManager.broadcastFrame(jpegData: jpegData)
                        }
                    )
                    encoderReady = true
                    streamServer.clientManager.setScreenSize(width: w, height: h)
                }

                if encoderReady {
                    // Backpressure: skip frame if encoder is still working
                    guard encodingSemaphore.wait(timeout: .now()) == .success else { return }
                    encodeQueue.async {
                        videoEncoder.encode(pixelBuffer: pixelBuffer)
                        encodingSemaphore.signal()
                    }
                }
            }

            log("[stream] Capture started")

            // Print connection info to stdout (JSON for the CLI to parse)
            let info: [String: Any] = ["status": "streaming", "port": boundPort, "udid": deviceUDID]
            if let data = try? JSONSerialization.data(withJSONObject: info),
               let json = String(data: data, encoding: .utf8) {
                print(json)
                fflush(stdout)
            }

        } catch {
            FileHandle.standardError.write(Data("Error starting capture: \(error)\n".utf8))
            exit(1)
        }

        func shutdown() {
            log("[stream] Shutting down...")
            frameCapture.stop()
            videoEncoder.stop()
            streamServer.stop()
            exit(0)
        }

        // Shutdown handlers via DispatchSource (supports capturing context)
        func setupShutdown(sig: Int32) -> DispatchSourceSignal {
            // Ignore the default signal handler
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: shutdown)
            source.resume()
            return source
        }

        let _sigint = setupShutdown(sig: SIGINT)
        let _sigterm = setupShutdown(sig: SIGTERM)
        // The parent holds our stdin open and never writes to it: when it ends
        // (the parent exited, however it ended), so do we.
        Thread.detachNewThread {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            DispatchQueue.main.async(execute: shutdown)
        }
        // Prevent sources from being deallocated
        withExtendedLifetime((_sigint, _sigterm)) {
            RunLoop.main.run()
        }
        exit(0)
    }
}
