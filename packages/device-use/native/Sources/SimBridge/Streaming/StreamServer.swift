import Foundation
import Swifter

/// HTTP + WebSocket server for simulator screen streaming: MJPEG on
/// /stream.mjpeg, input on /ws, the screen's size on /config. It listens on
/// 127.0.0.1 only and answers only requests that carry its token as `?t=`.
final class StreamServer {
    let clientManager = StreamClientManager()
    private let server = HttpServer()
    private let token: [UInt8]

    init(token: String) {
        self.token = Array(token.utf8)
    }

    /// Starts listening on `port` (0: any free one) and returns the port it got.
    func start(port: UInt16) throws -> Int {
        // Every route, the WebSocket upgrade included, passes through here first.
        server.middleware.append { [token] request in
            let given = Array((request.queryParams.first { $0.0 == "t" }?.1 ?? "").utf8)
            return constantTimeEqual(given, token) ? nil : .forbidden
        }

        // MJPEG stream endpoint
        server["/stream.mjpeg"] = { [weak self] request in
            guard let self else { return .notFound }

            let client = self.clientManager.addMJPEGClient()

            return .raw(200, "OK", [
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
            ]) { writer in
                let semaphore = DispatchSemaphore(value: 0)

                client.setWriter { data in
                    do {
                        try writer.write(data)
                        return true
                    } catch {
                        semaphore.signal()
                        return false
                    }
                }

                // Send cached frame now that the writer is ready
                self.clientManager.sendLatestFrame(to: client)

                // Block until the client disconnects
                semaphore.wait()
                self.clientManager.removeMJPEGClient(client)
            }
        }

        // WebSocket endpoint (input only)
        server["/ws"] = websocket(
            binary: { [weak self] session, data in
                self?.clientManager.handleMessage(from: session, data: Data(data))
            },
            connected: { [weak self] session in
                self?.clientManager.addWSClient(session)
            },
            disconnected: { [weak self] session in
                self?.clientManager.removeWSClient(session)
            }
        )

        server["/config"] = { [weak self] _ in
            let w = self?.clientManager.screenWidth ?? 0
            let h = self?.clientManager.screenHeight ?? 0
            return .ok(.json(["width": w, "height": h] as AnyObject))
        }

        server.listenAddressIPv4 = "127.0.0.1"
        try server.start(port, forceIPv4: true, priority: .userInteractive)
        let bound = try server.port()
        log("[server] Listening on http://127.0.0.1:\(bound)")
        return bound
    }

    func stop() {
        clientManager.stop()
        server.stop()
    }
}

private func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
}
