import Foundation

enum DoctorCommand {

    static func execute() -> [String: Any] {
        var result: [String: Any] = [:]

        // Framework diagnostics
        let diag = FrameworkLoader.shared.diagnose()
        result["frameworks"] = diag

        // Booted simulators — try loading frameworks first
        if diag["coreSimulatorLoaded"] as? Bool == true {
            do {
                try FrameworkLoader.shared.loadAll()
                let booted = DeviceLookup.listBootedDevices()
                result["bootedSimulators"] = booted
                result["hasBootedSimulator"] = !booted.isEmpty
            } catch {
                result["bootedSimulators"] = [] as [Any]
                result["hasBootedSimulator"] = false
                result["deviceEnumerationError"] = error.localizedDescription
            }
        } else {
            result["bootedSimulators"] = [] as [Any]
            result["hasBootedSimulator"] = false
        }

        // Version
        result["version"] = "0.1.0"

        return result
    }
}
