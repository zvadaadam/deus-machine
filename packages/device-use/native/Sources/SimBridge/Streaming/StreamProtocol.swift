import Foundation

// WebSocket binary message types (client → server)
enum WSMessageType: UInt8 {
    case touch = 0x03
    case button = 0x04
}

struct TouchEventPayload: Codable {
    let type: String  // "begin", "move", "end"
    let x: Double     // normalized 0..1
    let y: Double     // normalized 0..1
}

struct ButtonEventPayload: Codable {
    let button: String  // "home", "lock"
}
