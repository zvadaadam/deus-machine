import Foundation

/// Queries the simulator's screen dimensions via `xcrun simctl io enumerate`.
enum ScreenInfo {

    struct Dimensions {
        let width: Int
        let height: Int
    }

    /// Get the main display pixel dimensions for a simulator.
    static func getScreenDimensions(udid: String) -> Dimensions? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "io", udid, "enumerate"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return nil }

        // Parse the largest display (main framebuffer)
        var maxWidth = 0
        var maxHeight = 0
        let lines = output.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            if line.contains("Default width:"), let w = parseIntValue(line) {
                if i + 1 < lines.count, lines[i + 1].contains("Default height:"),
                   let h = parseIntValue(lines[i + 1]) {
                    if w * h > maxWidth * maxHeight {
                        maxWidth = w
                        maxHeight = h
                    }
                }
            }
        }

        guard maxWidth > 0, maxHeight > 0 else { return nil }
        return Dimensions(width: maxWidth, height: maxHeight)
    }

    /// Normalize iOS point coordinates to [0, 1] range.
    /// Uses 3x scale factor by default (most modern iPhones).
    static func normalizeCoordinates(
        x: Double, y: Double,
        screenPixelWidth: Int, screenPixelHeight: Int
    ) -> (nx: Double, ny: Double) {
        // The accessibility tree returns coordinates in iOS points.
        // The screen pixel dimensions are typically 2x or 3x the point dimensions.
        // Common scale factors: 2x (iPhone SE, iPad), 3x (iPhone Pro/Plus)
        let scale = detectScale(pixelWidth: screenPixelWidth, pixelHeight: screenPixelHeight)
        let pointWidth = Double(screenPixelWidth) / scale
        let pointHeight = Double(screenPixelHeight) / scale

        let nx = min(max(x / pointWidth, 0.0), 1.0)
        let ny = min(max(y / pointHeight, 0.0), 1.0)
        return (nx, ny)
    }

    private static func detectScale(pixelWidth: Int, pixelHeight: Int) -> Double {
        // Known device resolutions → scale mappings
        switch (pixelWidth, pixelHeight) {
        case (1170, 2532): return 3.0  // iPhone 14, 15, 16
        case (1179, 2556): return 3.0  // iPhone 14 Pro, 15 Pro, 16 Pro
        case (1290, 2796): return 3.0  // iPhone 14/15/16 Pro Max
        case (1206, 2622): return 3.0  // iPhone 16 Pro
        case (1320, 2868): return 3.0  // iPhone 16 Pro Max
        case (750, 1334):  return 2.0  // iPhone SE 3
        case (1080, 1920): return 3.0  // iPhone SE 2 (at 3x)
        case (1125, 2436): return 3.0  // iPhone X/XS/11 Pro
        case (828, 1792):  return 2.0  // iPhone XR/11
        case (1242, 2688): return 3.0  // iPhone XS Max
        case (1170, 2340): return 3.0  // iPhone 16e
        default:
            // Heuristic: if width > 1000, likely 3x; otherwise 2x
            return pixelWidth > 1000 ? 3.0 : 2.0
        }
    }

    private static func parseIntValue(_ line: String) -> Int? {
        guard let range = line.range(of: ":\\s*", options: .regularExpression) else { return nil }
        let value = line[range.upperBound...].trimmingCharacters(in: .whitespaces)
        return Int(value)
    }
}
