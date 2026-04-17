import Foundation

/// Finds a SimDevice by UDID using the CoreSimulator framework's ObjC runtime.
enum DeviceLookup {

    /// Find a booted SimDevice matching the given UDID.
    /// Returns the raw NSObject representing the SimDevice.
    static func findDevice(udid: String) throws -> NSObject {
        let deviceSet = try getDeviceSet()
        let devices = try enumerateDevices(from: deviceSet)
        return try matchDevice(devices, udid: udid)
    }

    /// List all booted simulators (for diagnostics).
    static func listBootedDevices() -> [[String: Any]] {
        guard let deviceSet = try? getDeviceSet(),
              let devices = try? enumerateDevices(from: deviceSet) else {
            return []
        }

        return devices.compactMap { device in
            guard let uuid = getDeviceUDID(device),
                  let name = device.value(forKey: "name") as? String,
                  isDeviceBooted(device) else {
                return nil
            }
            return ["udid": uuid, "name": name, "state": "Booted"]
        }
    }

    // MARK: - Private

    /// Get the default SimDeviceSet, trying multiple approaches.
    private static func getDeviceSet() throws -> NSObject {
        // Approach 1: Via SimServiceContext (most reliable)
        if let deviceSet = try? getDeviceSetViaServiceContext() {
            return deviceSet
        }

        // Approach 2: Via SimDeviceSet directly
        if let deviceSet = try? getDeviceSetDirectly() {
            return deviceSet
        }

        // Approach 3: Via known default path
        if let deviceSet = try? getDeviceSetViaPath() {
            return deviceSet
        }

        throw SimError.frameworkNotFound("Cannot access SimDeviceSet. Try running: sudo xcode-select -s /Applications/Xcode.app")
    }

    private static func getDeviceSetViaServiceContext() throws -> NSObject {
        guard let contextClass = NSClassFromString("SimServiceContext") else {
            throw SimError.frameworkNotFound("SimServiceContext not found")
        }

        // SimServiceContext.sharedServiceContextForDeveloperDir:error:
        var developerDir = FrameworkLoader.shared.developerDir
        if developerDir.isEmpty {
            // Resolve developer dir ourselves
            let pipe = Pipe()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
            process.arguments = ["-p"]
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            developerDir = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        guard !developerDir.isEmpty else {
            throw SimError.xcodeNotFound
        }

        let sel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")

        guard (contextClass as AnyObject).responds(to: sel) else {
            throw SimError.frameworkNotFound("SimServiceContext does not respond to sharedServiceContextForDeveloperDir:error:")
        }

        // Use objc_msgSend-style approach via NSInvocation
        let context = try callClassMethod(
            cls: contextClass,
            selector: "sharedServiceContextForDeveloperDir:error:",
            arg: developerDir as NSString
        )

        // Get defaultDeviceSetWithError: from the context
        let deviceSet = try callInstanceMethod(
            obj: context,
            selector: "defaultDeviceSetWithError:"
        )

        return deviceSet
    }

    private static func getDeviceSetDirectly() throws -> NSObject {
        guard let deviceSetClass = NSClassFromString("SimDeviceSet") else {
            throw SimError.frameworkNotFound("SimDeviceSet not found")
        }

        // Try SimDeviceSet.defaultSet (no error param)
        let simpleSel = NSSelectorFromString("defaultSet")
        if (deviceSetClass as AnyObject).responds(to: simpleSel) {
            if let result = (deviceSetClass as AnyObject).perform(simpleSel) {
                return result.takeUnretainedValue() as! NSObject
            }
        }

        // Try defaultSetWithError: using our helper
        return try callClassMethod(
            cls: deviceSetClass,
            selector: "defaultSetWithError:",
            arg: nil
        )
    }

    private static func getDeviceSetViaPath() throws -> NSObject {
        guard let deviceSetClass = NSClassFromString("SimDeviceSet") else {
            throw SimError.frameworkNotFound("SimDeviceSet not found")
        }

        // Default path: ~/Library/Developer/CoreSimulator/Devices
        let defaultPath = NSHomeDirectory() + "/Library/Developer/CoreSimulator/Devices"
        let sel = NSSelectorFromString("setForSetPath:error:")

        guard (deviceSetClass as AnyObject).responds(to: sel) else {
            throw SimError.frameworkNotFound("SimDeviceSet.setForSetPath:error: not available")
        }

        return try callClassMethod(
            cls: deviceSetClass,
            selector: "setForSetPath:error:",
            arg: defaultPath as NSString
        )
    }

    /// Call a class method that takes one NSString arg and an NSError** out param.
    /// Pattern: + (id)methodName:(NSString *)arg error:(NSError **)error
    private static func callClassMethod(
        cls: AnyClass,
        selector: String,
        arg: NSString?
    ) throws -> NSObject {
        let sel = NSSelectorFromString(selector)

        // We can't use perform for NSError** params. Use NSInvocation-style approach.
        // Instead, try calling with nil for the error parameter
        if let arg = arg {
            // Two-arg method: perform(_:with:with:) passes arg + nil for error
            if let result = (cls as AnyObject).perform(sel, with: arg, with: nil) {
                return result.takeUnretainedValue() as! NSObject
            }
        } else {
            // One-arg method (just error): perform(_:with:) passes nil for error
            if let result = (cls as AnyObject).perform(sel, with: nil) {
                return result.takeUnretainedValue() as! NSObject
            }
        }

        throw SimError.frameworkNotFound("Failed to call \(selector)")
    }

    /// Call an instance method that takes only an NSError** out param.
    /// Pattern: - (id)methodName:(NSError **)error
    private static func callInstanceMethod(
        obj: NSObject,
        selector: String
    ) throws -> NSObject {
        let sel = NSSelectorFromString(selector)
        guard obj.responds(to: sel) else {
            throw SimError.frameworkNotFound("\(type(of: obj)) does not respond to \(selector)")
        }

        if let result = obj.perform(sel, with: nil) {
            return result.takeUnretainedValue() as! NSObject
        }

        throw SimError.frameworkNotFound("Failed to call \(selector)")
    }

    private static func enumerateDevices(from deviceSet: NSObject) throws -> [NSObject] {
        // Try different property names for the devices collection
        if let devices = deviceSet.value(forKey: "availableDevices") as? [NSObject] {
            return devices
        }
        if let devices = deviceSet.value(forKey: "devices") as? [NSObject] {
            return devices
        }

        throw SimError.deviceNotFound("Cannot enumerate devices from SimDeviceSet")
    }

    private static func getDeviceUDID(_ device: NSObject) -> String? {
        if let uuid = device.value(forKey: "UDID") as? UUID {
            return uuid.uuidString.uppercased()
        }
        if let str = device.value(forKey: "UDID") as? String {
            return str.uppercased()
        }
        return nil
    }

    private static func isDeviceBooted(_ device: NSObject) -> Bool {
        // State 3 = Booted in CoreSimulator
        if let state = device.value(forKey: "state") as? Int {
            return state == 3
        }
        return false
    }

    private static func matchDevice(_ devices: [NSObject], udid: String) throws -> NSObject {
        let target = udid.uppercased()

        for device in devices {
            guard let deviceUDID = getDeviceUDID(device), deviceUDID == target else {
                continue
            }

            if !isDeviceBooted(device) {
                throw SimError.deviceNotBooted(udid)
            }
            return device
        }

        throw SimError.deviceNotFound(udid)
    }
}
