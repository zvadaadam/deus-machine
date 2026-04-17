# device-use

iOS Simulator automation for AI agents — CLI, SDK, and engine.

Ported from [`expo/agent-simulator`](https://github.com/expo/agent-simulator), refactored
for [Bun](https://bun.sh) with a single-file compiled binary.

## Install (from source)

```bash
bun install
bun run build:native   # Builds simbridge Swift binary (requires Xcode)
bun run compile        # Produces ./bin/device-use + ./bin/simbridge
./bin/device-use install   # Installs the Claude skill
```

## Quick start

```bash
device-use list                      # List simulators
device-use boot "iPhone 17 Pro"      # Boot by name
device-use snapshot -i               # Dump interactive UI with @refs
device-use tap @e1                   # Tap by ref
device-use type "hello@example.com"  # Type into focused field
device-use screenshot result.png     # Capture screen
device-use doctor                    # Verify environment
```

## Architecture

- **`native/`** — Swift package (`simbridge`) that talks to private CoreSimulator
  and AccessibilityPlatform frameworks. Handles HID injection, accessibility
  queries, and MJPEG streaming.
- **`src/engine/`** — TypeScript primitives wrapping `xcrun simctl` and
  `simbridge` IPC. No CLI or SDK imports.
- **`src/cli/`** — Hand-rolled CLI with flat commands and JSON-when-piped.
- **`src/sdk/`** — Fluent `session()` builder for programmatic automation.
- **`skills/device-use/SKILL.md`** — Claude Code skill definition.

## Commands

| Command                      | Purpose                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `list`                       | List available simulators                                                         |
| `boot` / `shutdown` / `open` | Simulator lifecycle                                                               |
| `snapshot`                   | Accessibility tree with `@refs` (`-i` for interactive only, `--diff` for changes) |
| `screenshot`                 | PNG/JPEG capture, optionally base64                                               |
| `tap`                        | By `@ref`, `--id`, `--label`, or `-x -y`                                          |
| `type`                       | Into focused field, optional `--submit`                                           |
| `wait-for`                   | Poll until element appears/disappears                                             |
| `stream`                     | MJPEG screen server (`enable`/`disable`/`status`)                                 |
| `open-url`                   | Deep link / URL                                                                   |
| `session`                    | Manage default simulator + ref state                                              |
| `doctor`                     | Environment check                                                                 |
| `install`                    | Verify setup + install Claude skill                                               |

## SDK

```ts
import { session } from "device-use";

await session("iPhone 17 Pro").app("Maps").snapshot().tapOn("@e1").inputText("Coffee").run();
```

## Distribution

The compiled `./bin/device-use` is a single ~58 MB Bun executable. Ship
it alongside `./bin/simbridge` (~1.6 MB) — the CLI looks for `simbridge` as a
sibling of its own binary (or via `$DEVICE_USE_SIMBRIDGE` override).

## Requirements

- macOS 14+ with Xcode installed
- Bun 1.1+ (dev only — compiled binary has no runtime dep)

## Testing

```bash
bun test                   # Unit tests
bun run typecheck          # TS check
./bin/device-use doctor    # End-to-end env check
```
