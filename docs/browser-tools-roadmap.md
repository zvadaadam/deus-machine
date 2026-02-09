# Browser Tools — Roadmap & Research

Future enhancements for the browser automation system, plus competitive research from Claude Code's Chrome extension.

---

## Future Enhancements

### BrowserResize (Low effort)

Add a `BrowserResize` MCP tool for responsive design testing. `set_browser_webview_bounds` already exists in Rust — this just needs a thin sidecar tool wrapper.

- Agent tests at mobile (375x812), tablet (768x1024), desktop (1440x900)
- Screenshot at each breakpoint for layout comparison
- Useful for verifying responsive behavior after code changes

### BrowserGenerateTest — Test Generation from Browser Interactions (Medium effort)

When the AI agent interacts with the browser (navigate, click, type, wait), capture those interactions and auto-generate Playwright/Cypress test files. This is unique to our IDE — the agent can code a feature, test it in browser, and generate the test, all in one session.

**Architecture:**

```
Agent interacts with browser normally
        |
        v
  Sidecar MCP tools execute (BrowserClick, BrowserType, etc.)
        |
        v
  Each tool call is RECORDED with metadata
  (tool name, args, accessibility info from snapshot)
        |
        v
  Agent calls BrowserGenerateTest
        |
        v
  Sidecar transforms recording -> Playwright test file
        |
        v
  File written to workspace (e.g. tests/e2e/login.spec.ts)
```

**MCP Tool -> Playwright Mapping:**

| MCP Tool Call               | Recorded Metadata           | Playwright Output                                             |
|-----------------------------|-----------------------------|---------------------------------------------------------------|
| `BrowserNavigate(url)`      | URL                         | `page.goto(url)`                                              |
| `BrowserClick(ref)`         | role + name + selector      | `page.getByRole('button', { name: 'Sign In' }).click()`       |
| `BrowserType(text)`         | focused element's role/name | `page.getByRole('textbox', { name: 'Email' }).fill(text)`     |
| `BrowserWaitFor(text)`      | text                        | `expect(page.getByText(text)).toBeVisible()`                  |
| `BrowserSelectOption(ref)`  | role + name                 | `page.getByRole('combobox', { name: '...' }).selectOption(v)` |
| `BrowserSnapshot`           | full tree                   | Can emit assertions for key elements on the page              |

**Implementation — 3 pieces (~300-400 lines, no Rust changes):**

1. **Recording buffer** (~50 lines in `conductor-tools/browser.ts`) — Per-session array. Each tool handler appends `{ tool, ref, role, name, selector, timestamp }`.

2. **`BrowserGenerateTest` tool** (~150 lines) — New MCP tool. Input: `testName`, `testDescription`, optional `framework` (playwright/cypress). Reads buffer, transforms to target framework API, writes file to workspace, clears buffer.

3. **Selector strategy** (~100 lines) — Translate accessibility tree info into resilient Playwright selectors. Priority: `getByRole` > `getByTestId` > `getByText` > `locator(css)`.

**Example flow:**

```
User: "Add a login page and write tests for it"

Agent 1 (coder): Creates login component, route, API
Agent 2 (tester):
  -> BrowserNavigate to /login
  -> BrowserType email, password
  -> BrowserClick "Sign In"
  -> BrowserWaitFor "Dashboard"
  -> BrowserGenerateTest("login flow", "playwright")
  -> Writes tests/e2e/login.spec.ts
  -> Commits everything
```

### GIF Recording of Agent Actions (Medium effort)

Record the visual cursor + ripple interactions as animated GIFs. `screenshot_browser_webview` already exists — capture frames during interactions and stitch them. Useful for PR descriptions, bug reproductions, and agent session playback.

### Visual Regression Testing (Medium effort)

Agent takes baseline screenshots stored in `.context/`, re-screenshots after code changes, and pixel-diffs to flag visual regressions. Integrates with workspace diff to correlate code changes with visual changes.

### Other Ideas (Lower priority)

- **Natural language element find** — Fuzzy search on the accessibility tree ("find the login button") instead of requiring a snapshot + ref first
- **Network mocking** — Intercept requests via `WKURLSchemeHandler` to test edge cases (500 errors, slow responses, empty states)
- **A11y audit tool** — Extend existing accessibility tree into automated audit (missing ARIA labels, contrast, heading hierarchy)
- **React DevTools integration** — Inspect mode already walks React Fiber; extend to detect re-renders, show props/state, identify error boundaries

---

## Research: Claude Code Chrome Extension Browser Tools

Reference API for the Claude in Chrome browser automation extension. Documented here for comparison with our native browser tools — useful for identifying gaps and borrowing ideas.

### Tool Inventory

| Category | Tool | What It Does |
|---|---|---|
| Context | `tabs_context_mcp` | Discover existing tabs / create tab group |
| Context | `tabs_create_mcp` | Open a new empty tab |
| Navigation | `navigate` | Go to URL, or "back"/"forward" in history |
| Navigation | `resize_window` | Set viewport to specific pixel dimensions |
| Reading | `read_page` | Accessibility tree with ref IDs. Supports `filter: "interactive"`, subtree focus via `ref_id`, `depth` control, `max_chars` cap (default 50k) |
| Reading | `get_page_text` | Extract plain text content (article-focused) |
| Reading | `find` | Natural language element search ("login button", "search bar") — returns up to 20 matches with refs |
| Reading | `javascript_tool` | Execute arbitrary JS in page context, returns last expression |
| Interaction | `computer` | Mouse/keyboard/scroll/drag/screenshot. Actions: `screenshot`, `click`, `double_click`, `right_click`, `type`, `key`, `scroll`, `move`, `drag`, `wait`. Supports both coordinate `[x,y]` and ref-based targeting. Region crop for screenshots. Modifier keys (ctrl/shift/alt/meta). |
| Interaction | `form_input` | Set form values by ref — text inputs, checkboxes, selects, dates. More reliable than click+type. |
| Interaction | `upload_image` | Upload screenshot/image to file input (by ref) or drag-drop zone (by coordinate) |
| Debugging | `read_console_messages` | Console output (log/warn/error/debug). Pattern filter, onlyErrors flag, limit, clear buffer. |
| Debugging | `read_network_requests` | HTTP requests (XHR/Fetch/etc). URL pattern filter, limit, clear buffer. |
| Media | `gif_creator` | Record interactions as animated GIF. Start → interact → stop → export. Overlays: click indicators, action labels, progress bar, watermark. |
| Planning | `update_plan` | Present domains + approach for user approval before acting |
| Shortcuts | `shortcuts_list` | List saved shortcuts/workflows |
| Shortcuts | `shortcuts_execute` | Run a shortcut by ID or command |

### Key Differences from Our Tools

**They have, we don't:**

| Capability | Their Approach | How We Could Add It |
|---|---|---|
| Natural language `find` | Fuzzy search on accessibility tree by description | Add fuzzy matching layer on top of our existing YAML snapshot |
| `form_input` (reliable) | Set value directly by ref for checkboxes, selects, dates | Extend BrowserType or add BrowserSetValue tool |
| `upload_image` | Upload screenshots to file inputs / drop zones | Add via BrowserEvaluate or new tool |
| `resize_window` | Set viewport to exact pixel dimensions | Trivial — `set_browser_webview_bounds` already exists in Rust |
| `get_page_text` | Extract plain article text | Add via BrowserEvaluate (innerText extraction) |
| Coordinate-based click | `computer` tool with `[x, y]` | Our BrowserClick is ref-only — could add coordinate mode |
| `gif_creator` | Record + export with visual overlays | Capture frames from `screenshot_browser_webview` + stitch |
| Shortcuts/workflows | Save and replay common sequences | Could add as workspace-level saved browser macros |
| Region screenshot | Crop specific area of viewport | Our `screenshot_browser_webview` is full-page only |

**We have, they don't:**

| Capability | Our Approach |
|---|---|
| Cookie sync | Decrypt + inject from Chrome/Arc/Brave/Edge via Keychain |
| Visual cursor + ripple | User sees animated AI interactions in real-time |
| Inspect mode | Figma-style selector with React Fiber component detection |
| Native webview | No X-Frame-Options issues, full cookie/storage control |
| Workspace integration | Browser + code + diff + terminal in same agent session |
| Multi-agent isolation | Each agent gets its own browser tab automatically |
| SPA detection | pushState/replaceState interception via init script |
| Console buffering | Automatic capture with drain, no explicit start needed |

### Their `read_page` vs Our `BrowserSnapshot`

Both produce accessibility trees. Key differences:

- **Theirs:** Returns structured refs like `e42`, supports `filter: "interactive"` to reduce noise, `ref_id` to focus on subtree, configurable `depth` and `max_chars` (50k default)
- **Ours:** Returns YAML format with `ref-abc123` IDs, includes full tree always, no filtering/depth control

**Idea:** Add `filter` and `maxDepth` params to BrowserSnapshot to reduce token usage on heavy pages.

### Their `computer` Tool — Multi-Action Design

Their `computer` is a single tool handling 10+ actions (click, type, key, scroll, screenshot, drag, wait, move, double_click, right_click). Ours splits these into separate tools (BrowserClick, BrowserType, BrowserPressKey, etc.).

**Trade-off:** Their approach = fewer tools for the model to choose from. Ours = cleaner per-tool schemas, easier to record/replay.

### Their `gif_creator` Workflow

```
1. gif_creator(action: "start")
2. computer(action: "screenshot")  ← capture first frame
3. ... perform interactions ...
4. computer(action: "screenshot")  ← capture last frame
5. gif_creator(action: "stop")
6. gif_creator(action: "export", filename: "demo.gif", download: true)
```

Options: `showClickIndicators`, `showDragPaths`, `showActionLabels`, `showProgressBar`, `showWatermark`, `quality` (1-30).

We already have visual cursor + ripple — recording these as frames would produce even better GIFs than theirs since our visual feedback is richer.
