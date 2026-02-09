# Browser Automation MCP Tools

Conductor MCP tools for controlling the embedded browser via accessibility tree snapshots and element ref-based interactions.

All browser tools accept an optional `webviewLabel` parameter to target a specific tab. When omitted, the active tab is used. In multi-agent setups, each session is automatically mapped to its own tab.

---

## BrowserSnapshot

Capture an accessibility snapshot of the current page. Returns a YAML-formatted tree with element roles, names, ref IDs, states, and values.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text`

```
- Page URL: https://example.com
- Page Title: Example

Accessibility snapshot:
- heading "Welcome" [level=1]
- textbox "Search" [ref-a1b2c3] [focused]
- button "Submit" [ref-d4e5f6]
```

---

## BrowserClick

Click a page element by ref ID. Element is scrolled into view, focused, and clicked with full mouse event simulation (mousedown → mouseup → click).

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ref` | `string` | Yes | Element's `data-cursor-ref` ID (e.g., `ref-abc123`) |
| `doubleClick` | `boolean` | No | Perform a double click |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — Updated page snapshot after click.

---

## BrowserType

Type text into an editable element. Element is focused first.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ref` | `string` | Yes | Element's `data-cursor-ref` ID |
| `text` | `string` | Yes | Text to type |
| `submit` | `boolean` | No | Press Enter after typing |
| `slowly` | `boolean` | No | Type character-by-character (triggers autocomplete/key handlers) |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — Updated page snapshot after typing.

---

## BrowserNavigate

Navigate the browser to a URL.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | Yes | URL to navigate to |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text`

```
Tab: browser-abc123
URL: https://example.com
Title: Example

Page snapshot:
- heading "Welcome" [level=1]
...
```

---

## BrowserWaitFor

Wait for a page condition before continuing. Provide exactly **one** of: `text`, `textGone`, or `time`.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | No | Wait until this text appears (polls every 500ms) |
| `textGone` | `string` | No | Wait until this text disappears (polls every 500ms) |
| `time` | `number` | No | Wait a fixed number of seconds |
| `timeout` | `number` | No | Max wait in seconds (default: 30). Only for text/textGone |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — Page snapshot after condition is met, or `"Wait completed successfully."` for time mode.

---

## BrowserEvaluate

Execute JavaScript in the page context. Code is wrapped in a Function constructor — write it as a function body with `return`.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | `string` | Yes | JS function body. E.g., `return document.title` |
| `ref` | `string` | No | Element ref — if provided, element is passed as `element` arg |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text`

```
Result: Example Page Title

Page snapshot:
...
```

---

## BrowserPressKey

Press a keyboard key dispatched to the currently focused element.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Key name (`Enter`, `Tab`, `Escape`, `ArrowDown`, `Backspace`, `a`, `1`, etc.) |
| `ctrl` | `boolean` | No | Hold Ctrl/Control |
| `shift` | `boolean` | No | Hold Shift |
| `alt` | `boolean` | No | Hold Alt/Option |
| `meta` | `boolean` | No | Hold Meta/Cmd |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — `"Pressed key: Enter"`

---

## BrowserHover

Hover over an element to reveal tooltips, dropdowns, or hover states.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | `string` | Yes | Human-readable description (e.g., `"the Settings button"`) |
| `ref` | `string` | Yes | Element's `data-cursor-ref` ID |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — Updated page snapshot showing hover result.

---

## BrowserSelectOption

Select option(s) in a `<select>` dropdown by value or visible text.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | `string` | Yes | Human-readable dropdown description (e.g., `"country selector"`) |
| `ref` | `string` | Yes | `<select>` element's `data-cursor-ref` ID |
| `values` | `string[]` | Yes | Values or text labels to select |
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — `"Selected 2 option(s) in country selector."` with updated snapshot.

---

## BrowserScroll

Scroll the page in a direction, or scroll a specific element into view. Returns a fresh accessibility snapshot with updated ref IDs after scrolling.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `direction` | `string` | No | `"up"`, `"down"`, `"left"`, `"right"`. Default: `"down"`. Ignored when `ref` is provided. |
| `amount` | `number` | No | Pixels to scroll (default 600 ≈ one viewport). Ignored when `ref` is provided. |
| `ref` | `string` | No | Element's `data-cursor-ref` ID — scrolls that element into view (centered). |
| `webviewLabel` | `string` | No | Target browser tab |

**Modes:**

- `direction: "down"` → scrolls content upward (reveals below), default 600px
- `ref: "ref-abc123"` → scrolls that element into view, centered in viewport

**Output:** `text` — Updated page snapshot after scrolling.

---

## BrowserNavigateBack

Go back to the previous page in browser history.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text` — Page snapshot with URL/title after navigating back.

---

## BrowserConsoleMessages

Return all console messages (log, warn, error, debug) captured since page load.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text`

```
Console messages (3):
[LOG] App initialized
[WARN] Deprecated API call
[ERROR] Failed to fetch /api/data
```

---

## BrowserScreenshot

Capture a JPEG screenshot of the current page via native WKWebView.takeSnapshot(). Supports full-page, region crop, or element-focused capture.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `webviewLabel` | `string` | No | Target browser tab |
| `ref` | `string` | No | Element's `data-cursor-ref` ID — auto-crops to that element with 16px padding |
| `rect` | `object` | No | Crop region: `{ x, y, width, height }` in CSS pixels. Takes priority over `ref`. |

**Capture modes:**

- No `ref` or `rect` → full visible viewport (1x, 50% JPEG quality)
- `ref: "ref-abc123"` → resolves element bounding rect, crops with 16px padding
- `rect: { x: 0, y: 0, width: 400, height: 300 }` → crops to exact region

**Output:** `image` + `text`

Returns a base64-encoded JPEG image content block (for visual analysis by the model) plus a text block with the source URL context and region info. This is the only tool that returns an image content block.

---

## BrowserNetworkRequests

Return all network requests made since page load.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `webviewLabel` | `string` | No | Target browser tab |

**Output:** `text`

```
Network requests (5):
[XHR] GET https://api.example.com/data (200, 120ms, 2.4KB)
[FETCH] POST https://api.example.com/submit (201, 340ms, 0.8KB)
...
```

