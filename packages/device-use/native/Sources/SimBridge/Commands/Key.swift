import Foundation

enum KeyCommand {

    static func execute(request: SimRequest) throws -> [String: Any] {
        guard let udid = request.udid else {
            throw SimError.invalidRequest("Missing required field: udid")
        }
        guard let keyCode = request.raw["keyCode"] as? Int ?? (request.raw["keyCode"] as? Double).map(Int.init) else {
            throw SimError.invalidRequest("Missing required field: keyCode")
        }

        try FrameworkLoader.shared.loadAll()
        let device = try DeviceLookup.findDevice(udid: udid)

        let client = HIDClient(device: device)
        try HIDEvents.key(client: client, keyCode: keyCode)

        return ["keyPressed": keyCode]
    }
}
