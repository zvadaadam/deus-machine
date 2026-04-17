import Foundation

/// Loads Apple's private frameworks (CoreSimulator, SimulatorKit) via dlopen.
/// These frameworks provide access to simulator accessibility trees and HID event injection.
final class FrameworkLoader {
    static let shared = FrameworkLoader()

    private(set) var coreSimulatorLoaded = false
    private(set) var simulatorKitLoaded = false
    private(set) var axpTranslationLoaded = false
    private(set) var developerDir: String = ""

    private init() {}

    /// Load all required frameworks. Call once at startup.
    func loadAll() throws {
        developerDir = try findDeveloperDir()
        try loadCoreSimulator()
        try loadSimulatorKit()
        loadAccessibilityPlatformTranslation()
    }

    /// Check which frameworks are available without failing.
    func diagnose() -> [String: Any] {
        var result: [String: Any] = [:]

        // Developer dir
        if let dir = try? findDeveloperDir() {
            result["developerDir"] = dir
        } else {
            result["developerDir"] = NSNull()
            result["developerDirError"] = "xcode-select -p failed"
        }

        // CoreSimulator
        let coreSimPath = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
        if FileManager.default.fileExists(atPath: coreSimPath) {
            result["coreSimulatorPath"] = coreSimPath
            result["coreSimulatorExists"] = true
            if let _ = dlopen(coreSimPath, RTLD_NOW) {
                result["coreSimulatorLoaded"] = true

                // Check key classes
                let classes = ["SimServiceContext", "SimDeviceSet", "SimDevice", "SimRuntime"]
                for cls in classes {
                    result["class_\(cls)"] = NSClassFromString(cls) != nil
                }
            } else {
                result["coreSimulatorLoaded"] = false
                result["coreSimulatorDlError"] = String(cString: dlerror())
            }
        } else {
            result["coreSimulatorExists"] = false
        }

        // SimulatorKit
        if let dir = try? findDeveloperDir() {
            let simKitPath = "\(dir)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
            if FileManager.default.fileExists(atPath: simKitPath) {
                result["simulatorKitPath"] = simKitPath
                result["simulatorKitExists"] = true
                if let _ = dlopen(simKitPath, RTLD_NOW) {
                    result["simulatorKitLoaded"] = true
                } else {
                    result["simulatorKitLoaded"] = false
                    result["simulatorKitDlError"] = String(cString: dlerror())
                }
            } else {
                result["simulatorKitExists"] = false
            }
        }

        return result
    }

    // MARK: - Private

    private func findDeveloperDir() throws -> String {
        if let env = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] {
            return env
        }

        let pipe = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        process.arguments = ["-p"]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw SimError.xcodeNotFound
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty else {
            throw SimError.xcodeNotFound
        }

        return path
    }

    private func loadCoreSimulator() throws {
        let path = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
        guard FileManager.default.fileExists(atPath: path) else {
            throw SimError.frameworkNotFound("CoreSimulator not found at \(path)")
        }
        guard dlopen(path, RTLD_NOW) != nil else {
            let err = String(cString: dlerror())
            throw SimError.frameworkNotFound("Failed to load CoreSimulator: \(err)")
        }
        coreSimulatorLoaded = true
        log("CoreSimulator loaded")
    }

    private func loadSimulatorKit() throws {
        let path = "\(developerDir)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
        guard FileManager.default.fileExists(atPath: path) else {
            throw SimError.frameworkNotFound("SimulatorKit not found at \(path)")
        }
        guard dlopen(path, RTLD_NOW) != nil else {
            let err = String(cString: dlerror())
            throw SimError.frameworkNotFound("Failed to load SimulatorKit: \(err)")
        }
        simulatorKitLoaded = true
        log("SimulatorKit loaded")
    }

    private func loadAccessibilityPlatformTranslation() {
        let path = "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation"
        // Use dlopen directly — FileManager.fileExists fails on symlinks in /System
        if dlopen(path, RTLD_NOW) != nil {
            axpTranslationLoaded = true
            log("AccessibilityPlatformTranslation loaded")
        } else {
            log("Failed to load AccessibilityPlatformTranslation: \(String(cString: dlerror()))")
        }
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[simbridge] \(message)\n".utf8))
}
