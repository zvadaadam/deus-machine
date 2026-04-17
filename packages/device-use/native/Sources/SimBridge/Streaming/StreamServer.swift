import Foundation
import Swifter

/// HTTP + WebSocket server for simulator screen streaming.
/// Transport-only: MJPEG on /stream.mjpeg, WebSocket on /ws, config on /config.
/// The HTML viewer lives in the TS CLI layer (src/cli/stream/viewer-html.ts).
final class StreamServer {
    let clientManager = StreamClientManager()
    private let server = HttpServer()
    private let port: UInt16

    init(port: UInt16 = 3100) {
        self.port = port
    }

    func start() throws {
        // MJPEG stream endpoint
        server["/stream.mjpeg"] = { [weak self] request in
            guard let self else { return .notFound }

            let client = self.clientManager.addMJPEGClient()

            return .raw(200, "OK", [
                "Content-Type": "multipart/x-mixed-replace; boundary=frame",
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
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

        // Config endpoint (explicit CORS so file:// viewer can fetch it)
        server["/config"] = { [weak self] _ in
            let w = self?.clientManager.screenWidth ?? 0
            let h = self?.clientManager.screenHeight ?? 0
            let body = #"{"width":\#(w),"height":\#(h)}"#
            let data = Array(body.utf8)
            return .raw(200, "OK", [
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
            ]) { writer in
                try? writer.write(data)
            }
        }

        // Health endpoint
        server["/health"] = { _ in
            return .ok(.json(["status": "ok"] as AnyObject))
        }

        // CORS preflight
        server.middleware.append { request in
            if request.method == "OPTIONS" {
                return HttpResponse.raw(204, "No Content", [
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                ], { _ in })
            }
            return nil
        }

        try server.start(port, forceIPv4: false, priority: .userInteractive)
        log("[server] Listening on http://0.0.0.0:\(port)")
    }

    func stop() {
        clientManager.stop()
        server.stop()
    }
}
