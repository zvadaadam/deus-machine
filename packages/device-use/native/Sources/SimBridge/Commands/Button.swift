import Foundation
import ObjCBridge

enum ButtonCommand {

    static func execute(request: SimRequest) throws -> [String: Any] {
        guard let udid = request.udid else {
            throw SimError.invalidRequest("Missing required field: udid")
        }
        guard let button = request.raw["button"] as? String else {
            throw SimError.invalidRequest("Missing required field: button")
        }

        try FrameworkLoader.shared.loadAll()
        let device = try DeviceLookup.findDevice(udid: udid)

        do {
            try SimAccessibilityBridge.sendButton(toDevice: device, button: button)
        } catch {
            throw SimError.hidFailed("Button '\(button)' press failed: \(error.localizedDescription)")
        }

        return ["buttonPressed": button]
    }
}
