import Foundation

// MARK: - Request

struct SimRequest {
    let command: String
    let udid: String?
    let raw: [String: Any]

    static func parse(_ json: String) throws -> SimRequest {
        guard let data = json.data(using: .utf8),
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let command = obj["command"] as? String
        else {
            throw SimError.invalidRequest("Malformed JSON input")
        }
        return SimRequest(command: command, udid: obj["udid"] as? String, raw: obj)
    }
}

// MARK: - Response

struct SimResponse: Encodable {
    let success: Bool
    let command: String
    let data: AnyCodable?
    let error: SimErrorInfo?
    let timing: TimingInfo?

    func toJSON() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else {
            return #"{"success":false,"command":"unknown","error":{"code":"ENCODE_ERROR","message":"Failed to encode response"}}"#
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

struct SimErrorInfo: Encodable {
    let code: String
    let message: String
    let details: String?
}

struct TimingInfo: Encodable {
    let durationMs: Int
}

// MARK: - Errors

enum SimError: Error, CustomStringConvertible {
    case invalidRequest(String)
    case frameworkNotFound(String)
    case xcodeNotFound
    case deviceNotFound(String)
    case deviceNotBooted(String)
    case accessibilityFailed(String)
    case hidFailed(String)
    case timeout
    case unknown(String)

    var code: String {
        switch self {
        case .invalidRequest: return "INVALID_REQUEST"
        case .frameworkNotFound: return "FRAMEWORK_NOT_FOUND"
        case .xcodeNotFound: return "XCODE_NOT_FOUND"
        case .deviceNotFound: return "DEVICE_NOT_FOUND"
        case .deviceNotBooted: return "DEVICE_NOT_BOOTED"
        case .accessibilityFailed: return "ACCESSIBILITY_FAILED"
        case .hidFailed: return "HID_FAILED"
        case .timeout: return "TIMEOUT"
        case .unknown: return "UNKNOWN"
        }
    }

    var description: String {
        switch self {
        case .invalidRequest(let msg): return msg
        case .frameworkNotFound(let msg): return msg
        case .xcodeNotFound: return "Xcode not found. Install Xcode and run: xcode-select --install"
        case .deviceNotFound(let udid): return "Simulator not found: \(udid)"
        case .deviceNotBooted(let udid): return "Simulator not booted: \(udid)"
        case .accessibilityFailed(let msg): return "Accessibility query failed: \(msg)"
        case .hidFailed(let msg): return "HID event failed: \(msg)"
        case .timeout: return "Operation timed out"
        case .unknown(let msg): return msg
        }
    }
}

// MARK: - AnyCodable (encode arbitrary values)

struct AnyCodable: Encodable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as String: try container.encode(v)
        case let v as Int: try container.encode(v)
        case let v as Double: try container.encode(v)
        case let v as Bool: try container.encode(v)
        case let v as [Any]: try container.encode(v.map { AnyCodable($0) })
        case let v as [String: Any]: try container.encode(v.mapValues { AnyCodable($0) })
        case is NSNull: try container.encodeNil()
        default:
            // Fallback: attempt string representation
            try container.encode(String(describing: value))
        }
    }
}
