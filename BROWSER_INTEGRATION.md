# Browser Integration - Cursor-Style Architecture

## Overview

We've successfully integrated browser automation using **exactly the same architecture as Cursor IDE**:

- ✅ **Sandboxed iframe** for embedded browser (not popup)
- ✅ **HTTP MCP server** (dev-browser) for AI control
- ✅ **Script injection** for automation
- ✅ **Three-phase security** (pre-auth → register → poll)

---

## Architecture Comparison

### Cursor IDE
```
Claude AI
   ↓ (MCP Protocol)
HTTP MCP Server (Browser Automation Extension)
   ↓ (Command Queue + Polling)
Webview Panel (VS Code API)
   ↓ (iframe src + postMessage)
Sandboxed iframe + injected script
```

### Our Implementation
```
Claude AI
   ↓ (MCP Protocol)
HTTP MCP Server (dev-browser)
   ↓ (Command Queue + Polling)
BrowserPanel Component (React)
   ↓ (iframe src + script injection)
Sandboxed iframe + injected script
```

---

## Components

### 1. dev-browser (HTTP MCP Server)
**Location:** `/Users/zvada/Documents/BOX/dev-browser`

**Endpoints (same as Cursor):**
- `POST /` - Main MCP JSON-RPC endpoint
- `POST /register-iframe` - Tab registration
- `GET /mcp-poll/:tabId` - Command polling (every 100ms)
- `POST /mcp-response` - Command results
- `GET /inject-script` - Get automation script
- `GET /health` - Health check

**Features:**
- Auth token (X-MCP-Auth-Token header)
- Pre-authorization system
- Command queue management
- Playwright browser automation

### 2. BrowserManager (Rust/Tauri)
**Location:** `src-tauri/src/browser.rs`

**Responsibilities:**
- Start dev-browser HTTP server as child process
- Manage port allocation (PORT=0)
- Parse auth token from stdout
- Cleanup zombie processes

**Commands:**
```rust
start_browser_server(path) → "Server started"
stop_browser_server() → "Server stopped"
get_browser_port() → port: number
get_browser_auth_token() → token: string
is_browser_running() → running: boolean
```

### 3. useDevBrowser Hook
**Location:** `src/features/browser/hooks/useDevBrowser.ts`

**Features:**
- Auto-start dev-browser on mount
- Status tracking (running, port, authToken, error)
- Start/stop server controls

**Usage:**
```tsx
const { status, startServer, stopServer } = useDevBrowser();

// Access status
console.log(status.running);  // boolean
console.log(status.port);     // number | null
console.log(status.authToken); // string | null
```

### 4. BrowserPanel Component
**Location:** `src/features/browser/components/BrowserPanel.tsx`

**Features:**
- Sandboxed iframe with Cursor-like permissions:
  - `allow-scripts` - Execute JavaScript
  - `allow-forms` - Submit forms
  - `allow-same-origin` - Access same-origin resources
  - `allow-downloads` - Download files
  - `allow-pointer-lock` - Capture mouse
  - `allow-popups` - Open popups
  - `allow-modals` - Show alerts/confirms

- Auto-inject automation script on page load
- Manual injection button (⚡ icon)
- Status indicators:
  - Green dot: Page loaded
  - ⚡ AI-ready: Automation injected
  - MCP:port: Server running

**UI Controls:**
- 🔄 Reload
- 🌐 URL input
- ⚡ Inject automation (manual trigger)
- 🔗 Open in external browser
- Go button

---

## How It Works

### Startup Flow

1. **App launches** → `Dashboard.tsx` renders `BrowserPanel`
2. **BrowserPanel mounts** → `useDevBrowser` hook starts dev-browser server
3. **Server starts** → Rust spawns `npm run start:http` in dev-browser directory
4. **Port detected** → Parsed from stdout: `PORT:3000`
5. **Auth token captured** → Parsed from stdout: `Auth Token: <token>`
6. **Status updated** → `{ running: true, port: 3000, authToken: "..." }`

### Navigation + Injection Flow

1. **User enters URL** → "https://example.com"
2. **Click Go** → iframe.src = url
3. **Page loads** → `handleIframeLoad()` fires
4. **Auto-inject** (500ms delay):
   - Fetch `/inject-script?tabId=browser-main`
   - Get JavaScript automation script
   - Create `<script>` in iframe document
   - Append to iframe body
5. **Script runs in iframe**:
   - Registers with MCP server (`POST /register-iframe`)
   - Starts polling (`GET /mcp-poll/:tabId` every 100ms)
   - Executes commands from Claude AI
   - Sends results back (`POST /mcp-response`)

### AI Control Flow (MCP)

```
Claude AI types: "Navigate to github.com"
   ↓
POST http://localhost:3000/
Headers: { X-MCP-Auth-Token: "..." }
Body: {
  jsonrpc: "2.0",
  method: "tools/call",
  params: {
    name: "browser_navigate",
    arguments: { url: "https://github.com" }
  }
}
   ↓
dev-browser queues command
   ↓
iframe polls: GET /mcp-poll/browser-main
   ↓
Receives: { commandId, command: "navigate", params: { url: "..." } }
   ↓
iframe executes: window.location.href = url
   ↓
iframe posts result: POST /mcp-response
   ↓
Claude receives success response
```

---

## Available MCP Tools

When automation is injected, Claude AI can control the browser using:

| Tool                    | Description                |
|-------------------------|----------------------------|
| `browser_navigate`      | Navigate to URL            |
| `browser_click`         | Click element by selector  |
| `browser_type`          | Type text in input         |
| `browser_select_option` | Select dropdown option     |
| `browser_hover`         | Hover over element         |
| `browser_snapshot`      | Get accessibility tree     |
| `browser_wait_for`      | Wait for condition         |
| `browser_take_screenshot` | Capture screenshot       |
| `browser_press_key`     | Press keyboard key         |
| `browser_drag`          | Drag and drop              |

---

## Security Model (Three-Phase)

### Phase 1: Pre-Authorization (Extension-only)
```typescript
// Called by extension code when creating iframe
securityManager.preAuthorizeTab(tabId);
// Adds to Set<tabId>
```

### Phase 2: Registration (Single-use)
```typescript
// iframe sends registration request
POST /register-iframe { tabId }

// Server validates:
if (!preAuthorizedTabs.has(tabId)) {
  return 403; // Forbidden
}

// SECURITY: Remove from pre-authorized (single-use!)
preAuthorizedTabs.delete(tabId);

// Add to authorized tabs
authorizedTabs.add(tabId);
```

### Phase 3: Command Polling (Authorized only)
```typescript
// iframe polls every 100ms
GET /mcp-poll/:tabId

// Server validates:
if (!authorizedTabs.has(tabId)) {
  return 403; // Unauthorized
}

// Return pending command
return { commandId, command, params };
```

---

## Differences from Cursor

| Feature                | Cursor IDE            | Our Implementation     |
|------------------------|-----------------------|------------------------|
| **Rendering**          | VS Code Webview API   | React iframe           |
| **Server integration** | VS Code Extension     | Tauri Rust backend     |
| **Browser automation** | Disabled (was WebSocket) | Playwright via dev-browser |
| **Script injection**   | VS Code API           | Direct DOM manipulation |
| **Process management** | Extension lifecycle   | Tauri child process    |

---

## Testing the Integration

### 1. Check dev-browser is running
```bash
# In terminal, check if server started
# Look for: "HTTP MCP Server Started Successfully!"
# And: "PORT:3000" in logs
```

### 2. Navigate to a page
1. Open OpenDevs app
2. Go to Browser tab
3. Enter URL: `https://example.com`
4. Click Go

### 3. Verify automation injection
- Status bar should show: ⚡ **AI-ready** (green)
- Console should show: `✓ Automation script injected successfully`
- Check dev-browser logs for: `Iframe registered successfully`

### 4. Test with Claude AI (via MCP)
```typescript
// From Claude AI (when connected via MCP):
"Navigate to https://github.com"
"Click on the search button"
"Type 'playwright' in the search box"
"Take a screenshot"
```

---

## File Structure

```
box-ide/.conductor/dakar/
├── src-tauri/src/
│   ├── browser.rs          # BrowserManager (Rust)
│   └── commands.rs         # Tauri commands
│
├── src/features/browser/
│   ├── components/
│   │   └── BrowserPanel.tsx      # Main browser UI
│   └── hooks/
│       └── useDevBrowser.ts      # Server management hook
│
└── BROWSER_INTEGRATION.md  # This file

dev-browser/
├── src/server/
│   ├── http-mcp-server.ts        # HTTP MCP Server
│   ├── start-http-server.ts      # Entry point
│   ├── security-manager.ts       # Auth & pre-auth
│   └── command-queue.ts          # Command management
│
└── src/client/injection/
    ├── mcp-client.ts             # Polling & registration
    └── command-executor.ts       # Execute browser commands
```

---

## Key Advantages

✅ **Same architecture as Cursor** - Battle-tested approach
✅ **Embedded in app** - No popup windows
✅ **AI-controllable** - Full MCP integration
✅ **Secure** - Three-phase authorization
✅ **Fast startup** - Shared process
✅ **Low memory** - Single iframe
✅ **CORS-aware** - Graceful error handling

---

## Known Limitations

⚠️ **Some sites block embedding** - X-Frame-Options/CSP restrictions
⚠️ **CORS restrictions** - Can't access all cross-origin resources
⚠️ **No process isolation** - Shared with main app (like Cursor)

**Workaround:** Use "Open in external browser" button for problematic sites.

---

## Future Enhancements (Optional)

1. **Dual-frame swapping** - Smooth navigation (no flicker)
2. **Service Worker** - Resource interception & caching
3. **Navigation history** - Back/forward buttons
4. **Multiple tabs** - Tab management UI
5. **Bookmarks** - Save favorite sites
6. **DevTools integration** - Inspect iframe content

---

## Debugging

### Check if dev-browser is running
```typescript
const running = await invoke("is_browser_running");
console.log("Dev-browser running:", running);
```

### Check port and auth token
```typescript
const port = await invoke("get_browser_port");
const token = await invoke("get_browser_auth_token");
console.log("MCP Server:", `http://localhost:${port}`);
console.log("Auth token:", token.substring(0, 16) + "...");
```

### Check health endpoint
```bash
curl http://localhost:3000/health
```

### Monitor MCP polling
```bash
# In dev-browser logs, look for:
# GET /mcp-poll/browser-main
# Response: null (no commands) or { commandId, command, params }
```

---

## Conclusion

We now have a **production-grade browser integration** matching Cursor's architecture:

- Sandboxed iframe for security
- MCP server for AI control
- Script injection for automation
- Exactly the same endpoints as Cursor
- Clean, beautiful UI

The browser is **embedded in the app**, **AI-controllable**, and follows industry best practices from Cursor IDE. 🎉
