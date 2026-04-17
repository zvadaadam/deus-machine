---
name: device-use
description: "iOS Simulator automation CLI for AI agents. Use this skill to observe, interact with, and automate iOS simulator apps — tap elements, type text, take screenshots, read accessibility trees, and stream screens."
---

# device-use

iOS Simulator automation CLI. Observe, interact, and stream iOS apps through structured commands.

## Commands

### Simulator Lifecycle

```bash
device-use list                          # List available simulators
device-use list --booted                 # List only booted simulators
device-use boot "iPhone 17 Pro"          # Boot a simulator by name
device-use boot <UDID>                   # Boot by UDID
device-use shutdown "iPhone 17 Pro"      # Shutdown specific simulator
device-use shutdown --all                # Shutdown all simulators
device-use open                          # Open Simulator.app window
```

### Apps

```bash
device-use apps                          # All installed apps with bundle IDs
device-use apps --user                   # Only user-installed apps
device-use apps --system                 # Only built-in Apple apps
device-use appstate com.apple.Preferences  # Is it installed / running / pid
device-use launch com.apple.Maps         # Launch an app
device-use launch com.apple.Maps --relaunch  # Terminate first, then launch
device-use terminate com.apple.Maps      # Kill a running app
```

### Permissions

Pre-grant system permissions so authorization dialogs don't block your flow.

```bash
device-use permission grant  location   com.apple.Maps
device-use permission grant  photos     ai.deus.machine
device-use permission revoke microphone com.example.app
device-use permission reset  all        com.example.app  # Reset only this app
device-use permission reset  all                         # Reset every app
```

Services: `calendar`, `contacts`, `contacts-limited`, `location`, `location-always`,
`photos`, `photos-add`, `media-library`, `microphone`, `motion`, `reminders`, `siri`, `all`.

Actions: `grant`, `revoke`, `reset`.

### Observe the Screen

```bash
device-use snapshot                      # Full tree with structural context
device-use snapshot -i                   # Only branches containing interactive refs
device-use snapshot -i --flat            # One line per ref, no hierarchy
device-use snapshot -i --diff            # Include diff vs previous snapshot
device-use snapshot -i --hidden          # Include off-screen interactive nodes
device-use screenshot                    # Capture to stdout (base64 when piped)
device-use screenshot output.png         # Capture to file
device-use screenshot output.png --annotate  # Draw @ref boxes on the screenshot
device-use screenshot --base64           # Explicit base64 output
```

`snapshot` returns a **structured tree** — interactive nodes get `@refs`, non-interactive
nodes (containers, StaticText) are kept for context. Use `--flat` if you only want the
flat ref list. **Refs are only assigned to on-screen elements by default** (visible-first);
`--hidden` includes off-screen interactive nodes for audits.

### Interact

```bash
device-use tap @e1                       # Tap element by @ref
device-use tap --id "loginButton"        # Tap by accessibility ID
device-use tap --label "Sign In"         # Tap by visible label
device-use tap -x 200 -y 400             # Tap by x,y coordinates
device-use swipe --from 200,500 --to 200,100                # Drag gesture
device-use swipe --from 100,400 --to 300,400 --duration 0.3 # Slower swipe
device-use type "hello@example.com"      # Type text into focused field
device-use type "search query" --submit  # Type and press enter
device-use fill @e3 "me@example.com"     # Tap + type in one atomic step
device-use fill --label Password "secret" --submit  # With submit
device-use wait-for --label "Welcome"    # Wait until an element appears
device-use wait-for --id "spinner" --gone --timeout 20   # Wait until element gone
device-use open-url https://example.com  # Open URL or deep link in simulator
device-use open-url myapp://home --accept # Auto-tap the iOS URL-scheme confirm
```

### iOS platform gotchas (affect automation)

- **SwiftUI `TabView` tab buttons are NOT in the accessibility tree.** Tap tabs by
  coordinate (the tab bar is at y≈830 on a 402×874 logical screen) or use deep links.
- **`SecureField` reports type=`TextField`** on iOS 26 — match by `--id`, not type.
- **SwiftUI `Toggle` reports type=`CheckBox`** on iOS 26.
- **`Slider.value` is normalized 0..1** in the a11y tree, not the real range.
- **Custom URL schemes** trigger an iOS "Open in 'App'?" modal on iOS 26; tap `Open`
  to accept. Universal links (https://) don't.
- **`simctl privacy grant location`** doesn't cover widget-specific location prompts.

### Query (unified find / is / exists / get)

```bash
device-use query --label "Sign In"                   # Matches containing "Sign In"
device-use query --label "Sign In" --exact           # Strict equality
device-use query --id loginButton --get bool         # true/false
device-use query --type Button --get count           # How many buttons?
device-use query --type StaticText --get text       # Extract text from matches
device-use query --label Welcome --wait 10 --get bool  # Wait up to 10s
```

Filters (combine with AND): `--label`, `--id`, `--type`, `--role`, `--value`.
Default match is substring; `--exact` flips to strict equality.
Output shape: `--get refs | attrs | text | bool | count` (default `attrs`).
Aliases: `find`, `is`, `exists`.

### Stream

```bash
device-use stream enable                 # Start MJPEG stream server
device-use stream status                 # Check if streaming
device-use stream disable                # Stop stream
```

### Session State

Stores the default simulator + the last `@ref` map between commands.

```bash
device-use session show                          # Show current defaults
device-use session set --simulator "iPhone 17"   # Pin a default simulator
device-use session clear                         # Reset state + refs
```

### Diagnostics

```bash
device-use doctor                        # Check environment and dependencies
device-use install                       # Verify setup and install this skill
```

## Workflow Pattern

Follow this loop when automating iOS simulator interactions:

1. **Boot** a simulator if none is running:

   ```bash
   device-use list --booted --json 2>/dev/null
   # If empty, boot one:
   device-use boot "iPhone 17 Pro"
   ```

2. **Observe** the current screen state:

   ```bash
   device-use snapshot -i --json 2>/dev/null
   ```

   Returns interactive elements with `@ref` identifiers (e.g., `@e1`, `@e2`).

3. **Act** on an element:

   ```bash
   device-use tap @e1
   device-use type "hello"
   ```

4. **Re-observe** after each action — `@ref` identifiers change between snapshots:

   ```bash
   device-use snapshot -i --json 2>/dev/null
   ```

5. **Verify** with a screenshot if needed:
   ```bash
   device-use screenshot verify.png
   ```

## Important Notes

- **@refs are ephemeral**: They change after every interaction. Always re-run `snapshot -i` before tapping.
- **Use `--json` for parsing**: All commands support `--json` for structured output. JSON is also the default when stdout is piped.
- **Redirect stderr**: `simbridge` emits diagnostics on stderr. Use `2>/dev/null` when parsing JSON output.
- **One simulator at a time**: Use `--simulator <UDID>` to target a specific device when multiple are booted.
- **Session defaults**: Use `device-use session set --simulator <UDID>` to set a default for subsequent commands.

## JSON Output Format

All commands return this envelope in JSON mode:

```json
{
  "success": true,
  "command": "snapshot",
  "data": { ... },
  "message": "optional human-readable message",
  "nextSteps": [{"command": "tap @e1", "label": "Tap first element"}],
  "warnings": []
}
```

On failure:

```json
{ "success": false, "error": "..." }
```

### `snapshot` data shape

```json
{
  "tree": [
    {
      "type": "Application", "label": "Settings",
      "frame": { "x": 0, "y": 0, "width": 402, "height": 874 },
      "center": { "x": 201, "y": 437 },
      "children": [
        { "type": "Button", "ref": "@e1", "label": "General",
          "interactive": true, "enabled": true,
          "frame": {...}, "center": {...} },
        { "type": "Group",
          "children": [
            { "type": "StaticText", "label": "iOS Version, 26.1" },
            { "type": "Button", "ref": "@e2", "label": "iOS Version, 26.1", "interactive": true, ... }
          ]
        }
      ]
    }
  ],
  "refs": [ { "ref": "@e1", "type": "Button", ... }, { "ref": "@e2", ... } ],
  "counts": { "total": 16, "interactive": 2 }
}
```

- Only nodes with `interactive: true` have a `ref` — these are tappable now.
- Non-interactive nodes (containers, StaticText, Headings) are kept for **context**: they
  tell you what section an interactive element belongs to.
- `refs` is the flat DFS-ordered list — use it when you don't need hierarchy.

## Example: Complete Automation Flow

```bash
device-use boot "iPhone 17 Pro"
device-use open

device-use snapshot -i

device-use tap @e3            # Tap a text field
device-use type "test@example.com"
device-use tap @e5            # Tap "Sign In" button

device-use screenshot result.png
device-use snapshot -i        # See the post-login state
```
