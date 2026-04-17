import Foundation

/// Converts raw accessibility data (NSDictionary/NSArray from CoreSimulator)
/// into our clean JSON format with pre-parsed frames and computed centers.
enum AccessibilitySerializer {

    /// Serialize raw accessibility data into our output format.
    static func serialize(_ raw: Any) -> [String: Any] {
        var result: [String: Any] = [:]

        if let array = raw as? [Any] {
            let elements = array.map { serializeElement($0) }
            result["elements"] = elements
        } else if let dict = raw as? [String: Any] {
            let elements = [serializeElement(dict)]
            result["elements"] = elements
        } else {
            // Unknown format - wrap as-is
            result["elements"] = []
            result["raw"] = "\(raw)"
        }

        return result
    }

    // MARK: - Private

    private static func serializeElement(_ raw: Any) -> [String: Any] {
        guard let dict = raw as? [String: Any] ?? (raw as? NSDictionary as? [String: Any]) else {
            return ["type": "Unknown", "role": "Unknown"]
        }

        var element: [String: Any] = [:]

        // Role and type
        let role = (dict["AXRole"] as? String) ?? (dict["role"] as? String) ?? "Unknown"
        element["role"] = role
        element["type"] = deriveType(role)

        // Label
        if let label = dict["AXLabel"] as? String, !label.isEmpty {
            element["label"] = label.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Identifier
        if let identifier = dict["AXUniqueId"] as? String, !identifier.isEmpty {
            element["identifier"] = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Value
        if let value = dict["AXValue"] as? String, !value.isEmpty {
            element["value"] = value
        } else if let value = dict["AXValue"], !(value is NSNull) {
            element["value"] = "\(value)"
        }

        // Frame - parse from string "{{x, y}, {w, h}}" or from dict
        let frame = parseFrame(dict)
        element["frame"] = frame

        // Center - pre-computed
        element["center"] = [
            "x": frame["x"]! + frame["width"]! / 2.0,
            "y": frame["y"]! + frame["height"]! / 2.0,
        ]

        // Enabled
        element["enabled"] = dict["AXEnabled"] as? Bool ?? dict["enabled"] as? Bool ?? true

        // Focused
        if let focused = dict["AXFocused"] as? Bool ?? dict["focused"] as? Bool {
            element["focused"] = focused
        }

        // Traits
        var traits: [String] = []
        let type = element["type"] as? String ?? ""
        if isInteractiveType(type) {
            traits.append("interactive")
        }
        if let rawTraits = dict["AXTraits"] as? Int {
            // Map common trait bits
            if rawTraits & 1 != 0 { traits.append("button") }
            if rawTraits & 2 != 0 { traits.append("link") }
            if rawTraits & 4 != 0 { traits.append("header") }
            if rawTraits & 8 != 0 { traits.append("searchField") }
            if rawTraits & 16 != 0 { traits.append("image") }
            if rawTraits & 32 != 0 { traits.append("selected") }
            if rawTraits & 64 != 0 { traits.append("playsSound") }
            if rawTraits & 128 != 0 { traits.append("keyboardKey") }
            if rawTraits & 256 != 0 { traits.append("staticText") }
            if rawTraits & 512 != 0 { traits.append("summaryElement") }
            if rawTraits & 1024 != 0 { traits.append("notEnabled") }
            if rawTraits & 2048 != 0 { traits.append("updatesFrequently") }
        }
        element["traits"] = traits

        // Children
        if let children = dict["children"] as? [Any] {
            element["children"] = children.map { serializeElement($0) }
        } else if let children = dict["AXChildren"] as? [Any] {
            element["children"] = children.map { serializeElement($0) }
        } else {
            element["children"] = [] as [Any]
        }

        return element
    }

    private static func parseFrame(_ dict: [String: Any]) -> [String: Double] {
        // Try structured frame first
        if let frame = dict["frame"] as? [String: Any] ??
            dict["AXFrame"] as? [String: Any] {
            return [
                "x": (frame["x"] as? Double) ?? (frame["X"] as? Double) ?? 0,
                "y": (frame["y"] as? Double) ?? (frame["Y"] as? Double) ?? 0,
                "width": (frame["width"] as? Double) ?? (frame["Width"] as? Double) ?? 0,
                "height": (frame["height"] as? Double) ?? (frame["Height"] as? Double) ?? 0,
            ]
        }

        // Try string frame: "{{x, y}, {w, h}}"
        if let frameStr = dict["AXFrame"] as? String ?? dict["frame"] as? String {
            return parseFrameString(frameStr)
        }

        return ["x": 0, "y": 0, "width": 0, "height": 0]
    }

    private static func parseFrameString(_ str: String) -> [String: Double] {
        // Format: "{{x, y}, {w, h}}"
        let cleaned = str.replacingOccurrences(of: "{", with: "")
            .replacingOccurrences(of: "}", with: "")
            .replacingOccurrences(of: " ", with: "")
        let parts = cleaned.split(separator: ",").compactMap { Double($0) }
        guard parts.count >= 4 else {
            return ["x": 0, "y": 0, "width": 0, "height": 0]
        }
        return ["x": parts[0], "y": parts[1], "width": parts[2], "height": parts[3]]
    }

    private static func deriveType(_ role: String) -> String {
        // Strip "AX" prefix
        if role.hasPrefix("AX") {
            return String(role.dropFirst(2))
        }
        return role
    }

    private static func isInteractiveType(_ type: String) -> Bool {
        let interactive: Set<String> = [
            "Button", "TextField", "SecureTextField", "TextArea",
            "Switch", "Slider", "Stepper", "Picker", "Toggle",
            "CheckBox", "RadioButton", "Link", "MenuItem",
            "Tab", "TabBarButton", "SegmentedControl", "Cell",
            "PopUpButton", "ComboBox", "SearchField",
        ]
        return interactive.contains(type)
    }
}
