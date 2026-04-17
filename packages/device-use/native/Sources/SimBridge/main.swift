import Foundation

/// simbridge: Native bridge for iOS Simulator accessibility and HID interaction.
///
/// Usage:
///   simbridge '{"command":"accessibility","udid":"F408..."}'
///   echo '{"command":"tap","udid":"F408...","x":100,"y":200}' | simbridge

func main() {
    // Check for --stream mode (long-running server)
    if CommandLine.arguments.contains("--stream") {
        StreamMain.run(args: Array(CommandLine.arguments.dropFirst()))
        // StreamMain.run() never returns
    }

    let startTime = Date()

    // Read JSON input from CLI argument or stdin
    let input: String
    if CommandLine.arguments.count > 1 {
        input = CommandLine.arguments[1]
    } else {
        // Read from stdin
        guard let stdinData = readLine(strippingNewline: false) else {
            writeError(command: "unknown", error: SimError.invalidRequest("No input provided"))
            exit(1)
        }
        input = stdinData
    }

    // Parse request
    let request: SimRequest
    do {
        request = try SimRequest.parse(input)
    } catch {
        writeError(command: "unknown", error: error)
        exit(1)
    }

    // Dispatch to command handler
    do {
        let data: [String: Any]

        switch request.command {
        case "accessibility", "describe-ui":
            data = try DescribeUICommand.execute(request: request)

        case "tap":
            data = try TapCommand.execute(request: request)

        case "type":
            data = try TypeCommand.execute(request: request)

        case "swipe":
            data = try SwipeCommand.execute(request: request)

        case "key":
            data = try KeyCommand.execute(request: request)

        case "button":
            data = try ButtonCommand.execute(request: request)

        case "doctor":
            data = DoctorCommand.execute()

        default:
            throw SimError.invalidRequest("Unknown command: \(request.command)")
        }

        let elapsed = Int(Date().timeIntervalSince(startTime) * 1000)
        let response = SimResponse(
            success: true,
            command: request.command,
            data: AnyCodable(data),
            error: nil,
            timing: TimingInfo(durationMs: elapsed)
        )
        print(response.toJSON())

    } catch {
        writeError(command: request.command, error: error)
        exit(1)
    }
}

private func writeError(command: String, error: Error) {
    let simError: SimError
    if let se = error as? SimError {
        simError = se
    } else {
        simError = .unknown(error.localizedDescription)
    }

    let response = SimResponse(
        success: false,
        command: command,
        data: nil,
        error: SimErrorInfo(
            code: simError.code,
            message: simError.description,
            details: nil
        ),
        timing: nil
    )
    print(response.toJSON())
}

main()
