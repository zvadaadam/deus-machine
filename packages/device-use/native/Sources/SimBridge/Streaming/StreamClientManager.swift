import Foundation
import Swifter

/// Manages WebSocket clients for input and MJPEG stream clients for video.
final class StreamClientManager {
    private var wsSessions: [ObjectIdentifier: WebSocketSession] = [:]
    private let queue = DispatchQueue(label: "client-manager")

    private(set) var screenWidth = 0
    private(set) var screenHeight = 0

    /// Latest JPEG frame data, replaced on each new frame
    private var latestFrame: Data?
    private var mjpegClients: [ObjectIdentifier: MJPEGClient] = [:]

    var onTouch: ((TouchEventPayload) -> Void)?
    var onButton: ((String) -> Void)?

    // MARK: - Configuration

    func setScreenSize(width: Int, height: Int) {
        queue.async {
            self.screenWidth = width
            self.screenHeight = height
        }
    }

    // MARK: - MJPEG Client Management

    func addMJPEGClient() -> MJPEGClient {
        let client = MJPEGClient()
        let key = ObjectIdentifier(client)
        queue.async {
            self.mjpegClients[key] = client
            log("[clients] MJPEG client connected (\(self.mjpegClients.count) total)")
        }
        return client
    }

    /// Send the latest cached frame to a client (call after writer is set).
    func sendLatestFrame(to client: MJPEGClient) {
        queue.async {
            if let frame = self.latestFrame {
                client.send(frame: frame)
            }
        }
    }

    func removeMJPEGClient(_ client: MJPEGClient) {
        let key = ObjectIdentifier(client)
        queue.async {
            self.mjpegClients.removeValue(forKey: key)
            log("[clients] MJPEG client disconnected (\(self.mjpegClients.count) total)")
        }
    }

    // MARK: - WebSocket Client Management (input only)

    func addWSClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        queue.async {
            self.wsSessions[id] = session
            log("[clients] WS input client connected (\(self.wsSessions.count) total)")
        }
    }

    func removeWSClient(_ session: WebSocketSession) {
        let id = ObjectIdentifier(session)
        queue.async {
            self.wsSessions.removeValue(forKey: id)
            log("[clients] WS input client disconnected (\(self.wsSessions.count) total)")
        }
    }

    // MARK: - Message Handling

    func handleMessage(from session: WebSocketSession, data: Data) {
        guard data.count >= 1 else { return }
        let type = data[0]

        if type == WSMessageType.touch.rawValue {
            guard let json = try? JSONDecoder().decode(TouchEventPayload.self, from: data[1...]) else { return }
            onTouch?(json)
        } else if type == WSMessageType.button.rawValue {
            guard let json = try? JSONDecoder().decode(ButtonEventPayload.self, from: data[1...]) else { return }
            onButton?(json.button)
        }
    }

    // MARK: - Frame Broadcasting

    func broadcastFrame(jpegData: Data) {
        queue.async {
            self.latestFrame = jpegData
            guard !self.mjpegClients.isEmpty else { return }
            for (_, client) in self.mjpegClients {
                client.send(frame: jpegData)
            }
        }
    }

    func stop() {
        queue.async {
            for (_, client) in self.mjpegClients {
                client.close()
            }
            self.mjpegClients.removeAll()
            self.wsSessions.removeAll()
        }
    }
}

/// Represents a single MJPEG streaming client with a continuation-based writer.
final class MJPEGClient {
    private var writer: ((Data) -> Bool)?
    private let boundary = "frame"
    private var closed = false

    func setWriter(_ writer: @escaping (Data) -> Bool) {
        self.writer = writer
    }

    func send(frame jpegData: Data) {
        guard !closed, let writer = writer else { return }
        var chunk = Data()
        let header = "--\(boundary)\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpegData.count)\r\n\r\n"
        chunk.append(Data(header.utf8))
        chunk.append(jpegData)
        chunk.append(Data("\r\n".utf8))
        if !writer(chunk) {
            closed = true
        }
    }

    func close() {
        closed = true
        writer = nil
    }
}
