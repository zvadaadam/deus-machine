import Foundation

enum TapCommand {

    static func execute(request: SimRequest) throws -> [String: Any] {
        guard let udid = request.udid else {
            throw SimError.invalidRequest("Missing required field: udid")
        }
        guard let x = request.raw["x"] as? Double ?? (request.raw["x"] as? Int).map(Double.init) else {
            throw SimError.invalidRequest("Missing required field: x")
        }
        guard let y = request.raw["y"] as? Double ?? (request.raw["y"] as? Int).map(Double.init) else {
            throw SimError.invalidRequest("Missing required field: y")
        }

        // Normalize iOS point coordinates to [0, 1] for IndigoHID
        let (nx, ny) = normalizeForDevice(x: x, y: y, udid: udid)

        try FrameworkLoader.shared.loadAll()
        let device = try DeviceLookup.findDevice(udid: udid)

        let client = HIDClient(device: device)
        try HIDEvents.tap(client: client, x: nx, y: ny)

        return ["tapped": ["x": x, "y": y, "normalized": ["x": nx, "y": ny]]]
    }
}

/// Normalize iOS point coordinates to [0, 1] range for IndigoHID.
func normalizeForDevice(x: Double, y: Double, udid: String) -> (Double, Double) {
    // If coordinates are already in [0, 1] range, use them directly
    if x >= 0 && x <= 1 && y >= 0 && y <= 1 {
        return (x, y)
    }

    // Query screen dimensions and normalize
    guard let screen = ScreenInfo.getScreenDimensions(udid: udid) else {
        log("WARNING: Cannot get screen dimensions, using raw coordinates")
        return (x, y)
    }

    let normalized = ScreenInfo.normalizeCoordinates(
        x: x, y: y,
        screenPixelWidth: screen.width,
        screenPixelHeight: screen.height
    )
    return (normalized.nx, normalized.ny)
}
