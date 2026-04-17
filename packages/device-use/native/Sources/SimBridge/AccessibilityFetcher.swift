import Foundation
import ObjCBridge

/// Fetches the iOS accessibility tree from a booted simulator via CoreSimulator's
/// sendAccessibilityRequestAsync API, using the ObjC bridge for proper block calling.
enum AccessibilityFetcher {

    /// Fetch the full accessibility tree for a simulator device.
    static func fetch(device: NSObject) throws -> Any {
        do {
            let result = try SimAccessibilityBridge.fetchAccessibility(fromDevice: device)
            return result
        } catch {
            throw SimError.accessibilityFailed(error.localizedDescription)
        }
    }
}
