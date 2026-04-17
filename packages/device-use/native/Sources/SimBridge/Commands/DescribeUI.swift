import Foundation

enum DescribeUICommand {

    static func execute(request: SimRequest) throws -> [String: Any] {
        guard let udid = request.udid else {
            throw SimError.invalidRequest("Missing required field: udid")
        }

        try FrameworkLoader.shared.loadAll()
        let device = try DeviceLookup.findDevice(udid: udid)
        let rawTree = try AccessibilityFetcher.fetch(device: device)
        let serialized = AccessibilitySerializer.serialize(rawTree)

        return serialized
    }
}
