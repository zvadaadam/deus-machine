import Foundation
import ObjCBridge

/// Wrapper for HID event injection using the ObjC bridge.
final class HIDClient {
    private let device: NSObject

    init(device: NSObject) {
        self.device = device
    }

    /// Send a tap event at the given normalized coordinates (0..1 range).
    /// Uses a single HID client for the entire down→move→up sequence so events
    /// are correlated as the same touch. Includes an intermediate move event
    /// to match real finger behavior (required for React Native TouchableOpacity).
    func tap(x: Double, y: Double, holdDuration: Double = 0.15) throws {
        do {
            try SimAccessibilityBridge.sendTap(toDevice: device, x: x, y: y, holdDuration: holdDuration)
        } catch {
            throw SimError.hidFailed("Tap failed at (\(x), \(y)): \(error.localizedDescription)")
        }

        Thread.sleep(forTimeInterval: 0.025)
    }

    /// Send a swipe gesture from one point to another.
    func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: Double = 0.3, steps: Int = 10) throws {
        let dx = (endX - startX) / Double(steps)
        let dy = (endY - startY) / Double(steps)
        let stepDelay = duration / Double(steps)

        do {
            try SimAccessibilityBridge.sendTouch(toDevice: device, x: startX, y: startY, isDown: true)
        } catch {
            throw SimError.hidFailed("Swipe touch-down failed: \(error.localizedDescription)")
        }
        Thread.sleep(forTimeInterval: 0.05)

        for i in 1...steps {
            let x = startX + dx * Double(i)
            let y = startY + dy * Double(i)
            do {
                try SimAccessibilityBridge.sendTouch(toDevice: device, x: x, y: y, isDown: true)
            } catch {
                throw SimError.hidFailed("Swipe move failed at step \(i): \(error.localizedDescription)")
            }
            Thread.sleep(forTimeInterval: stepDelay)
        }

        do {
            try SimAccessibilityBridge.sendTouch(toDevice: device, x: endX, y: endY, isDown: false)
        } catch {
            throw SimError.hidFailed("Swipe touch-up failed: \(error.localizedDescription)")
        }
        Thread.sleep(forTimeInterval: 0.025)
    }

    /// Type a string by sending individual key events.
    func typeText(_ text: String, submit: Bool = false) throws {
        for char in text {
            let (keyCode, shift) = keyCodeForCharacter(char)

            if shift {
                try sendKey(keyCode: 225, down: true, up: false)
            }
            try sendKey(keyCode: keyCode, down: true, up: true)
            if shift {
                try sendKey(keyCode: 225, down: false, up: true)
            }

            Thread.sleep(forTimeInterval: 0.02)
        }

        if submit {
            try sendKey(keyCode: 40, down: true, up: true)
        }
    }

    /// Send a single key event.
    func sendKey(keyCode: Int, down: Bool = true, up: Bool = true) throws {
        if down {
            do {
                try SimAccessibilityBridge.sendKey(toDevice: device, keyCode: keyCode, isDown: true)
            } catch {
                throw SimError.hidFailed("Key down failed for keycode \(keyCode): \(error.localizedDescription)")
            }
        }

        if up {
            do {
                try SimAccessibilityBridge.sendKey(toDevice: device, keyCode: keyCode, isDown: false)
            } catch {
                throw SimError.hidFailed("Key up failed for keycode \(keyCode): \(error.localizedDescription)")
            }
        }
    }
}

// MARK: - US Keyboard Layout

func keyCodeForCharacter(_ char: Character) -> (keyCode: Int, shift: Bool) {
    switch char {
    case "a"..."z":
        let offset = Int(char.asciiValue! - Character("a").asciiValue!)
        return (4 + offset, false)
    case "A"..."Z":
        let offset = Int(char.asciiValue! - Character("A").asciiValue!)
        return (4 + offset, true)
    case "1": return (30, false)
    case "2": return (31, false)
    case "3": return (32, false)
    case "4": return (33, false)
    case "5": return (34, false)
    case "6": return (35, false)
    case "7": return (36, false)
    case "8": return (37, false)
    case "9": return (38, false)
    case "0": return (39, false)
    case "\n", "\r": return (40, false)
    case "\t": return (43, false)
    case " ": return (44, false)
    case "-": return (45, false)
    case "=": return (46, false)
    case "[": return (47, false)
    case "]": return (48, false)
    case "\\": return (49, false)
    case ";": return (51, false)
    case "'": return (52, false)
    case "`": return (53, false)
    case ",": return (54, false)
    case ".": return (55, false)
    case "/": return (56, false)
    case "!": return (30, true)
    case "@": return (31, true)
    case "#": return (32, true)
    case "$": return (33, true)
    case "%": return (34, true)
    case "^": return (35, true)
    case "&": return (36, true)
    case "*": return (37, true)
    case "(": return (38, true)
    case ")": return (39, true)
    case "_": return (45, true)
    case "+": return (46, true)
    case "{": return (47, true)
    case "}": return (48, true)
    case "|": return (49, true)
    case ":": return (51, true)
    case "\"": return (52, true)
    case "~": return (53, true)
    case "<": return (54, true)
    case ">": return (55, true)
    case "?": return (56, true)
    default:
        return (44, false)
    }
}
