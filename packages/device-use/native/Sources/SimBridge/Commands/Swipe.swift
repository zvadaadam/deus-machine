import Foundation

enum SwipeCommand {

    static func execute(request: SimRequest) throws -> [String: Any] {
        guard let udid = request.udid else {
            throw SimError.invalidRequest("Missing required field: udid")
        }
        guard let startX = request.raw["startX"] as? Double ?? (request.raw["startX"] as? Int).map(Double.init) else {
            throw SimError.invalidRequest("Missing required field: startX")
        }
        guard let startY = request.raw["startY"] as? Double ?? (request.raw["startY"] as? Int).map(Double.init) else {
            throw SimError.invalidRequest("Missing required field: startY")
        }
        guard let endX = request.raw["endX"] as? Double ?? (request.raw["endX"] as? Int).map(Double.init) else {
            throw SimError.invalidRequest("Missing required field: endX")
        }
        guard let endY = request.raw["endY"] as? Double ?? (request.raw["endY"] as? Int).map(Double.init) else {
            throw SimError.invalidRequest("Missing required field: endY")
        }
        let duration = request.raw["duration"] as? Double ?? 0.3

        try FrameworkLoader.shared.loadAll()
        let device = try DeviceLookup.findDevice(udid: udid)

        // Normalize coordinates
        let (nsx, nsy) = normalizeForDevice(x: startX, y: startY, udid: udid)
        let (nex, ney) = normalizeForDevice(x: endX, y: endY, udid: udid)

        let client = HIDClient(device: device)
        try client.swipe(startX: nsx, startY: nsy, endX: nex, endY: ney, duration: duration)

        return [
            "swiped": [
                "from": ["x": startX, "y": startY],
                "to": ["x": endX, "y": endY],
                "duration": duration,
            ]
        ]
    }
}
