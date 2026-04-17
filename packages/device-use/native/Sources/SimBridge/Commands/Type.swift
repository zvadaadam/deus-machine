import Foundation

enum TypeCommand {

    static func execute(request: SimRequest) throws -> [String: Any] {
        guard let udid = request.udid else {
            throw SimError.invalidRequest("Missing required field: udid")
        }
        guard let text = request.raw["text"] as? String else {
            throw SimError.invalidRequest("Missing required field: text")
        }

        let submit = request.raw["submit"] as? Bool ?? false

        try FrameworkLoader.shared.loadAll()
        let device = try DeviceLookup.findDevice(udid: udid)

        let client = HIDClient(device: device)
        try HIDEvents.typeText(client: client, text: text, submit: submit)

        return ["typed": text, "submit": submit]
    }
}
