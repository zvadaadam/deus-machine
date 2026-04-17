import Foundation

/// Higher-level HID event operations that compose the HIDClient primitives.
enum HIDEvents {

    /// Perform a tap at coordinates using the given HID client.
    static func tap(client: HIDClient, x: Double, y: Double) throws {
        try client.tap(x: x, y: y)
    }

    /// Type text and optionally press Return.
    static func typeText(client: HIDClient, text: String, submit: Bool) throws {
        try client.typeText(text, submit: submit)
    }

    /// Send a single key press.
    static func key(client: HIDClient, keyCode: Int) throws {
        try client.sendKey(keyCode: keyCode, down: true, up: true)
    }

    /// Perform a swipe gesture from one point to another.
    static func swipe(
        client: HIDClient,
        startX: Double, startY: Double,
        endX: Double, endY: Double,
        duration: Double = 0.3,
        steps: Int = 10
    ) throws {
        try client.swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration, steps: steps)
    }
}
