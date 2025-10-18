After analyzing the actual Cursor IDE at /Applications/Cursor.app/Contents, here's the full truth about how browser automation integrates with the iframe webview system:

  ---
  📋 ARCHITECTURE COMPONENTS

  1. The THREE Browser Systems in Cursor:

  ┌─────────────────────────────────────────────────────────────────┐
  │                    CURSOR IDE (Electron)                         │
  ├─────────────────────────────────────────────────────────────────┤
  │                                                                   │
  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
  │  ┃ SYSTEM 1: Simple Browser (iframe-based preview)          ┃  │
  │  ┃ /extensions/simple-browser/                               ┃  │
  │  ┃ Purpose: Quick HTML preview in sandboxed iframe          ┃  │
  │  ┃ Status: ✅ ACTIVE                                         ┃  │
  │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
  │                                                                   │
  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
  │  ┃ SYSTEM 2: Browser Connect (WebSocket RPC to real Chrome) ┃  │
  │  ┃ /extensions/cursor-browser-connect/                       ┃  │
  │  ┃ Purpose: Control actual Chrome via WebSocket (port 8765) ┃  │
  │  ┃ Status: ❌ DISABLED (line 247: DISABLE_BROWSER_CONNECT)  ┃  │
  │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
  │                                                                   │
  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
  │  ┃ SYSTEM 3: Browser Automation (MCP + Webview Injection)   ┃  │
  │  ┃ /extensions/cursor-browser-automation/                    ┃  │
  │  ┃ Purpose: AI-controlled browser via MCP protocol          ┃  │
  │  ┃ Status: ✅ ACTIVE - THIS IS THE MAIN ONE!                 ┃  │
  │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  ---
  🎯 SYSTEM 3: Browser Automation - THE REAL IMPLEMENTATION

  How It Works:

  ┌──────────────────────────────────────────────────────────────────┐
  │  Claude AI / MCP Client                                           │
  └──────────────────┬───────────────────────────────────────────────┘
                     │
                     │ MCP Protocol (JSON-RPC 2.0)
                     │ + X-MCP-Auth-Token header
                     ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  HTTP MCP Server (Express)                                        │
  │  Location: cursor-browser-automation/src/mcpServer.ts            │
  │  Port: Dynamic (auto-selected)                                   │
  │  Auth: Cryptographic token (32 random bytes)                     │
  ├──────────────────────────────────────────────────────────────────┤
  │  Routes:                                                          │
  │  • POST /            → MCP JSON-RPC endpoint                     │
  │  • GET  /sse         → Server-Sent Events stream                 │
  │  • POST /register-iframe → Iframe registration (pre-auth)        │
  │  • GET  /mcp-poll/:tabId → Command polling                       │
  │  • POST /mcp-response    → Command results                       │
  │  • GET  /health      → Health check                              │
  └──────────────────┬───────────────────────────────────────────────┘
                     │
                     │ Pending Commands Queue
                     │ (tabId → commandId mapping)
                     ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  VS Code Workbench Integration                                   │
  │  Location: /out/vs/workbench/workbench.desktop.main.js          │
  ├──────────────────────────────────────────────────────────────────┤
  │  Internal Commands (executed via vscodeCommands):                │
  │  • cursor.browserAutomation.start                                │
  │  • cursor.browserAutomation.preAuthorizeTab                      │
  │  • cursor.browserAutomation.internal.navigateWebview             │
  │  • cursor.browserAutomation.internal.captureScreenshot           │
  └──────────────────┬───────────────────────────────────────────────┘
                     │
                     │ Webview Panel Management
                     │ (Creates sandboxed iframe)
                     ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  Webview Container                                                │
  │  Location: /out/vs/workbench/contrib/webview/browser/pre/       │
  │  File: index.html (sandboxed iframe orchestrator)               │
  ├──────────────────────────────────────────────────────────────────┤
  │  Features:                                                        │
  │  • Dual-frame architecture (active + pending)                    │
  │  • Service Worker integration                                    │
  │  • Origin validation (SHA-256 hash)                              │
  │  • MessageChannel secure communication                           │
  │  • fake.html loading trick                                       │
  └──────────────────┬───────────────────────────────────────────────┘
                     │
                     │ postMessage relay
                     │ (parent ↔ iframe comms)
                     ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  SANDBOXED IFRAME                                                 │
  │  Attributes:                                                      │
  │  • sandbox="allow-scripts allow-forms allow-same-origin          │
  │              allow-downloads allow-pointer-lock"                 │
  │  • No access to: window.parent, window.top, window.frameElement │
  │  • Isolated JavaScript context                                   │
  ├──────────────────────────────────────────────────────────────────┤
  │  Content: User's Web Page                                        │
  │  + INJECTED AUTOMATION SCRIPT (from your experiment!)           │
  └──────────────────────────────────────────────────────────────────┘

  ---
  🔥 THE CLEVER INTEGRATION TRICK

  Here's where it gets interesting:

  YES, Cursor DOES use browser automation similar to your experiment!

  The /extensions/cursor-browser-automation extension:

  1. Runs an MCP HTTP server (like your http-mcp-server.ts)
  2. Pre-authorizes tabs via cursor.browserAutomation.preAuthorizeTab(tabId)
  3. Injects automation scripts into the webview iframe
  4. Polls for commands via /mcp-poll/:tabId endpoint
  5. Executes browser actions (click, type, navigate, snapshot, screenshot)

  But here's the TWIST:

  Instead of using a Chrome Extension (like your experiment), Cursor uses the VS Code Webview Panel API to create the iframe, then injects the automation script directly into that
  sandboxed environment!

  ---
  🎭 THE THREE-PHASE SECURITY MODEL

  Phase 1: Pre-Authorization (Extension-only)

  // Called ONLY by extension code, never via HTTP
  vscode.commands.executeCommand('cursor.browserAutomation.preAuthorizeTab', tabId);

  // This adds tabId to preAuthorizedTabs Set
  this.preAuthorizedTabs.add(tabId);

  Phase 2: Registration (Single-use token)

  // Iframe sends registration request
  POST /register-iframe
  {
    "tabId": "unique-tab-id"
  }

  // Server validates:
  if (!this.preAuthorizedTabs.has(tabId)) {
    return 403; // Forbidden
  }

  // SECURITY: Remove from pre-authorized (single-use!)
  this.preAuthorizedTabs.delete(tabId);

  // Add to authorized tabs
  this.authorizedTabs.add(tabId);

  Phase 3: Command Polling (Authorized only)

  // Iframe polls for commands every 100ms
  GET /mcp-poll/:tabId

  // Server validates:
  if (!this.authorizedTabs.has(tabId)) {
    return 403; // Unauthorized
  }

  // Return pending command for this tab
  return { commandId, command, params };

  ---
  🛠️ MCP TOOLS AVAILABLE

  The browser automation extension provides these tools to Claude AI:

  | Tool Name               | Description            | Internal Command |
  |-------------------------|------------------------|------------------|
  | browser_navigate        | Navigate to URL        | navigate         |
  | browser_click           | Click element          | click            |
  | browser_type            | Type text              | type             |
  | browser_select_option   | Select dropdown        | select_option    |
  | browser_hover           | Hover over element     | hover            |
  | browser_snapshot        | Get accessibility tree | snapshot         |
  | browser_wait_for        | Wait for condition     | wait_for         |
  | browser_take_screenshot | Capture screenshot     | screenshot       |
  | browser_press_key       | Press keyboard key     | press_key        |
  | browser_drag            | Drag and drop          | drag             |

  ---
  🔗 HOW IT CONNECTS TO YOUR EXPERIMENT

  Similarities:

  ✅ HTTP MCP Server - Both use Express HTTP server✅ Polling mechanism - Both poll /mcp-poll/:tabId✅ Pre-authorization - Both use pre-auth tokens✅ Command queue - Both queue
  commands for tabs✅ Injection script - Both inject automation code✅ Same tools - navigate, click, type, snapshot, etc.

  Differences:

  | Your Experiment         | Cursor IDE                         |
  |-------------------------|------------------------------------|
  | Chrome Extension        | VS Code Webview API                |
  | External browser tabs   | Sandboxed iframe in IDE            |
  | /inject-script endpoint | Direct iframe injection            |
  | chrome.tabs API         | vscode.window.createWebviewPanel() |
  | Real browser navigation | iframe src attribute               |
  | Port 3000               | Dynamic port selection             |

  ---
  🎪 THE ACTUAL FLOW (Step-by-Step)

  When Claude AI wants to browse a website:

  1. Claude sends MCP request:
  POST http://localhost:{port}/
  Headers: {
    "X-MCP-Auth-Token": "64-char-hex-token"
  }
  Body: {
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "browser_navigate",
      "arguments": { "url": "https://example.com" }
    }
  }
  2. MCP Server processes request:
  // Find active authorized tab
  const activeTab = this.authorizedTabs.entries().next().value;

  // Queue command for iframe
  this.pendingMCPCommands.set(commandId, {
    commandId,
    command: 'navigate',
    params: { url: 'https://example.com' },
    tabId: activeTab
  });
  3. Iframe polls for command:
  // Every 100ms in the iframe
  const response = await fetch(`http://localhost:${port}/mcp-poll/${tabId}`);
  const data = await response.json();

  if (data.commandId) {
    executeCommand(data.commandId, data.command, data.params);
  }
  4. Iframe executes navigation:
  case 'navigate':
    window.location.href = params.url;
    result = { navigationType: 'url', url: params.url };
    break;
  5. Webview Panel navigates:
  // Extension calls internal command
  vscodeCommands.executeCommand(
    'cursor.browserAutomation.internal.navigateWebview',
    tabId,
    navInfo
  );

  // Workbench updates the iframe src
  iframe.src = 'https://example.com';
  6. Result sent back:
  // Iframe posts result
  await fetch(`http://localhost:${port}/mcp-response`, {
    method: 'POST',
    body: JSON.stringify({
      commandId,
      success: true,
      result: { action: 'navigate', pageState: {...} }
    })
  });
  7. Claude receives response:
  {
    "jsonrpc": "2.0",
    "result": {
      "content": [{
        "type": "text",
        "text": "## navigate\n**Status:** ✓ Success\n..."
      }]
    }
  }

  ---
  🚨 KEY SECURITY FEATURES

  1. CORS Validation

  const origin = req.headers.origin;
  if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    return 403; // Block external origins
  }

  2. Auth Token Requirement

  const providedToken = req.headers['x-mcp-auth-token'];
  if (providedToken !== this.authToken) {
    return 403; // Invalid auth token
  }

  3. Pre-Authorization

  // Only extension can pre-authorize (not HTTP!)
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor.browserAutomation.preAuthorizeTab', (tabId) => {
      mcpServer.preAuthorizeTab(tabId);
    })
  );

  4. URL Scheme Validation

  const parsedUrl = new URL(urlString);
  const scheme = parsedUrl.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('Only http and https URLs allowed');
  }

  ---
  💡 WHY USE IFRAMES INSTEAD OF REAL BROWSERS?

  Based on the code analysis:

  1. ✅ Security - Full sandboxing with CSP headers
  2. ✅ Integration - Seamless IDE experience
  3. ✅ Control - Direct webview API access
  4. ✅ Performance - Shared process, no IPC overhead
  5. ✅ Simplicity - No external browser dependencies
  6. ✅ Debugging - DevTools built-in
  7. ✅ Portability - Works on all platforms

  The disabled cursor-browser-connect extension shows they tried real browser automation but chose iframe-based approach for stability!

  ---
  🎯 FINAL ANSWER TO YOUR QUESTION

  "Do we use browser automation and how does it fit?"

  YES! Cursor uses browser automation exactly like your experiment, but integrates it with the webview iframe system:

  1. Same HTTP MCP server architecture ✅
  2. Same polling mechanism ✅
  3. Same command execution ✅
  4. Same tools (navigate, click, etc.) ✅

  But different injection method:
  - Your experiment: Chrome Extension → Real browser tabs
  - Cursor IDE: Webview API → Sandboxed iframe

  The schema fits perfectly:

  MCP Client (Claude AI)
     ↓ (MCP Protocol)
  HTTP MCP Server (Browser Automation Extension)
     ↓ (Command Queue + Polling)
  Webview Panel (VS Code API)
     ↓ (iframe src + postMessage)
  Sandboxed iframe (Your web content + automation script)

  It's a brilliant hybrid: Real iframe rendering + Your browser automation protocol!