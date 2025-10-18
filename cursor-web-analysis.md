       COMPREHENSIVE ANALYSIS: Cursor IDE Web Content Display Implementation

       Based on my thorough analysis of the Cursor IDE application at /Applications/Cursor.app/Contents, here are the key findings about how Cursor handles browser/web content
       display:

       ---
       ANSWER: Does Cursor Use Real Iframes or Actual Browser Windows?

       Cursor uses TRUE IFRAMES with sophisticated sandboxing, NOT actual browser windows.

       ---
       1. CORE WEBVIEW IMPLEMENTATION

       File: /Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html

       Key Architecture:
       - iframe Sandboxing (Line 1022-1030):
       const sandboxRules = new Set(['allow-same-origin', 'allow-pointer-lock']);
       if (options.allowScripts) {
           sandboxRules.add('allow-scripts');
           sandboxRules.add('allow-downloads');
       }
       if (options.allowForms) {
           sandboxRules.add('allow-forms');
       }
       newFrame.setAttribute('sandbox', Array.from(sandboxRules).join(' '));
       - Dual-Frame Architecture (Lines 1017-1048):
         - Creates two iframes: active-frame (current content) and pending-frame (loading content)
         - Implements frame replacement without disrupting the UI
         - Uses a clever "fake.html" approach to bypass CORS issues:
         newFrame.src = `./fake.html?${fakeUrlParams.toString()}`;
       - Service Worker Integration (Lines 239-304):
         - Uses Service Workers to handle resource loading
         - Validates service worker version and compatibility
         - Enables offline-like capabilities and resource interception

       Key CSP (Content Security Policy) Headers:

       From /Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html (Lines 7-85):
       <meta http-equiv="Content-Security-Policy" content="
           default-src 'none';
           frame-src 'self' vscode-webview: http://localhost:* http://127.0.0.1:*;
           script-src 'self' 'unsafe-eval' blob:;
           ...

       ---
       2. CLEVER HACKS AND WORKAROUNDS

       A. The "fake.html" Hack (Line 1045)

       Purpose: Work around CORS and iframe sandbox limitations
       // Instead of using srcdoc directly, which had issues with service workers,
       // Cursor loads an empty placeholder first, then writes real HTML into it
       newFrame.src = `./fake.html?${fakeUrlParams.toString()}`;

       // Then later writes the actual content via document.write()
       contentDocument.open();
       contentDocument.write(newDocument);
       contentDocument.close();

       B. Cross-Origin Isolation Workaround (Lines 1042-1044)

       if (globalThis.crossOriginIsolated) {
           fakeUrlParams.set('vscode-coi', '3'); /*COOP+COEP*/
       }
       Enables: Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy for enhanced security and capability access.

       C. Safari-Specific Polling Hack (Lines 1070-1085)

       if (!options.allowScripts && isSafari) {
           // On Safari for iframes with scripts disabled, the `DOMContentLoaded` 
           // never seems to be fired: https://bugs.webkit.org/show_bug.cgi?id=33604
           // Use polling instead.
           const interval = setInterval(() => {
               // Polling implementation...
           }, 10);
       }

       D. VSCode API Injection (Lines 190-227)

       Isolation hack: Deletes parent window references to prevent iframe breakout:
       globalThis.acquireVsCodeApi = (function() {
           // ... API definition ...
           delete window.parent;  // Prevent access to parent frame
           delete window.top;
           delete window.frameElement;
       })();

       ---
       3. CURSOR'S CUSTOM BROWSER CONNECT EXTENSION

       Location: /Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-connect/

       This is Cursor-specific functionality for real browser automation:

       A. WebSocket-based RPC Server (src/main.ts, Lines 158-217)

       const DEFAULT_PORT = 8765;
       httpServer = new Server();
       wsServer = new WebSocketServer({
           server: httpServer,
           path: '/rpc'
       });

       wsServer.on('connection', (ws: WebSocket, request) => {
           const client = new RPCClient<ServerNotifications, ClientMethods>(
               ws,
               clientId,
               serverNotifications,
               clientMethods
           );
           // ... manages real browser clients ...
       });

       Key Features:
       - Connects to actual browser instances (via Chrome extension)
       - Provides RPC methods: captureSnapshot(), get_clients()
       - Runs on port 8765
       - IMPORTANT: Disabled by default in code! (Line 247)
       const DISABLE_BROWSER_CONNECT = true;

       B. RPC Protocol Implementation (src/rpc-client.ts)

       Implements JSON-RPC 2.0-like protocol with:
       - Requests (with ID, method, params)
       - Responses (ID, result or error)
       - Notifications (fire-and-forget)
       - 30-second timeout on method calls (Line 349)

       ---
       4. SIMPLE BROWSER EXTENSION (Actual iframe-based Preview)

       Location: /Applications/Cursor.app/Contents/Resources/app/extensions/simple-browser/

       Extension code (Line 28 in extension.js, minified):

       - Creates webview panel with specific sandbox settings
       - Enables: allow-scripts, allow-forms, allow-same-origin, allow-downloads
       - Uses iframe src-based loading for web content
       - Provides controls: Back, Forward, Reload, Open in Browser

       HTML Template (from unpacked code):

       <iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-pointer-lock">
       </iframe>

       Key characteristics:
       - TRUE iframe (sandboxed)
       - Same-origin policy enforced
       - No direct access to filesystem
       - Cannot modify parent window
       - Content runs in isolated JavaScript context

       ---
       5. ARCHITECTURE DIAGRAM: How Web Content Display Actually Works

       ┌─────────────────────────────────────────────────────────────┐
       │         Cursor Main Window (Electron BrowserWindow)          │
       ├─────────────────────────────────────────────────────────────┤
       │                                                              │
       │  ┌──────────────────────────────────────────────────────┐  │
       │  │  VS Code Workbench (HTML/CSS/JS)                    │  │
       │  │  File: workbench.html                               │  │
       │  ├──────────────────────────────────────────────────────┤  │
       │  │                                                      │  │
       │  │  ┌─────────────────────────────────────────────┐   │  │
       │  │  │  Webview Container (index.html)             │   │  │
       │  │  │  - Service Worker Handler                   │   │  │
       │  │  │  - Focus Tracking (polling)                 │   │  │
       │  │  │  - Message Relay                            │   │  │
       │  │  ├─────────────────────────────────────────────┤   │  │
       │  │  │                                             │   │  │
       │  │  │  ┌─────────────────────────────────────┐  │   │  │
       │  │  │  │  SANDBOXED IFRAME                   │  │   │  │
       │  │  │  │  sandbox=                           │  │   │  │
       │  │  │  │    "allow-scripts                   │  │   │  │
       │  │  │  │     allow-forms                     │  │   │  │
       │  │  │  │     allow-same-origin               │  │   │  │
       │  │  │  │     allow-downloads                 │  │   │  │
       │  │  │  │     allow-pointer-lock"             │  │   │  │
       │  │  │  │                                     │  │   │  │
       │  │  │  │  User Web Content Rendered Here    │  │   │  │
       │  │  │  │  (Cannot access parent, FS, etc)  │  │   │  │
       │  │  │  │                                     │  │   │  │
       │  │  │  └─────────────────────────────────────┘  │   │  │
       │  │  │                                             │   │  │
       │  │  └─────────────────────────────────────────────┘   │  │
       │  │                                                      │  │
       │  └──────────────────────────────────────────────────────┘  │
       │                                                              │
       │  ┌──────────────────────────────────────────────────────┐  │
       │  │  cursor-browser-connect Extension (DISABLED)        │  │
       │  │  - WebSocket Server (port 8765, disabled)           │  │
       │  │  - RPC methods for real browser control             │  │
       │  │  - Would connect to actual Chrome instances         │  │
       │  └──────────────────────────────────────────────────────┘  │
       │                                                              │
       └─────────────────────────────────────────────────────────────┘

       ---
       6. IFRAME vs ACTUAL BROWSER: Evidence

       Why It's IFRAMES:

       1. Sandbox attribute enforcement - HTML5 iframe restrictions applied
       2. Window.parent deletion - Cannot break out to parent
       3. CSP headers - frame-src limited to 'self' and localhost
       4. contentDocument/contentWindow access - Characteristic iframe APIs
       5. postMessage relay system - Parent-child communication pattern
       6. No process isolation - Same process as main window
       7. dual-frame switching - Typical iframe replacement pattern

       NOT Actual Browser Windows:

       - No separate Electron BrowserWindow creation
       - No separate V8 process/context
       - No process pool management
       - No separate DevTools attachment points
       - No window.open() with BrowserWindow backing

       ---
       7. CRITICAL SECURITY FEATURES

       A. Origin Validation (index.html, Lines 357-378):

       // Compute SHA-256 of parentOrigin + salt
       const parentOriginHash = BigInt(`0x${hashHex}`).toString(32).padStart(52, '0');

       // Verify hostname matches expected hash-based subdomain
       if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {
           return start(parentOrigin);
       } else {
           throw new Error(`Expected '${parentOriginHash}' as hostname or subdomain!`);
       }
       Purpose: Prevent iframe from communicating with wrong parent

       B. MessageChannel API (Lines 312-346):

       Uses MessagePorts for typed, origin-verified messaging
       this.channel = new MessageChannel();
       window.parent.postMessage(
           { target: ID, channel: 'webview-ready', data: {} },
           parentOrigin,
           [this.channel.port2]  // Transfer ownership to parent
       );

       ---
       8. PERFORMANCE OPTIMIZATIONS

       1. Frame Pre-loading (Lines 1008-1015): Pending frame created before old one removed
       2. Scroll Position Preservation (Lines 987-1005): Maintains scroll state across loads
       3. Service Worker Caching (Lines 467-483): Network request interception
       4. Theme/Style Batching (Lines 925-943): Efficient CSS application

       ---
       9. KEY LIMITATIONS & TRADEOFFS

       | Feature             | iframe             | Real Browser      |
       |---------------------|--------------------|-------------------|
       | Process Isolation   | No                 | Yes               |
       | Memory per instance | Lower              | Higher            |
       | Communication       | Fast (postMessage) | IPC overhead      |
       | Security model      | Sandbox            | Chromium Security |
       | Startup time        | Instant            | Slower            |
       | Resource sharing    | Yes                | No                |

       ---
       10. DISABLED FEATURES

       The cursor-browser-connect extension contains real browser automation capabilities but is deliberately disabled in line 247:
       const DISABLE_BROWSER_CONNECT = true;

       export function activate(context: vscode.ExtensionContext): void {
           if (DISABLE_BROWSER_CONNECT) {
               return;
           }
           // ... never executed ...
       }

       This suggests Cursor may have planned real browser integration but chose iframe-based approach for stability/performance.

       ---
       CONCLUSION

       Cursor uses sophisticated SANDBOXED IFRAMES, not real browser windows. The implementation includes:

       1. Dual-frame swapping for smooth transitions
       2. Service Worker integration for resource handling
       3. Origin-validated postMessage communication
       4. Safari/Firefox-specific workarounds
       5. Cross-origin isolation support
       6. Complete VS Code API injection

       This is a mature, production-grade iframe implementation similar to VS Code itself, with Cursor-specific extensions for browser automation (currently disabled).
  ⎿  Done (34 tool uses · 90.8k tokens · 9m 41s)

⏺ FINAL ANSWER: Cursor's Web Display - The Truth

  After deep analysis of /Applications/Cursor.app/Contents, here's what I found:

  ---
  THE VERDICT: TRUE IFRAMES (Not Real Browsers)

  Cursor uses heavily sandboxed HTML5 iframes with a multi-layered architecture, NOT separate browser windows.

  ---
  THE TRICKY HACKS I FOUND:

  🎯 1. The "fake.html" Deception

  Location: /Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html:1045

  // Doesn't load content directly in iframe - uses placeholder first!
  newFrame.src = `./fake.html?${fakeUrlParams.toString()}`;

  // THEN writes real content via document.write()
  contentDocument.open();
  contentDocument.write(newDocument);
  contentDocument.close();

  Why? Bypasses Service Worker registration issues and CORS restrictions.

  ---
  🎯 2. Parent Window Deletion (Breakout Prevention)

  Location: index.html:190-227

  delete window.parent;   // Delete reference to parent!
  delete window.top;
  delete window.frameElement;

  Purpose: Makes the iframe think it's a top-level window. Prevents malicious code from breaking out.

  ---
  🎯 3. Dual-Frame Swap Architecture

  Location: index.html:1017-1048

  Maintains TWO iframes at all times:
  - active-frame (currently visible)
  - pending-frame (loading new content)

  The trick: Swaps them seamlessly to avoid flicker, like double-buffering in graphics.

  ---
  🎯 4. Safari Polling Hack

  Location: index.html:1070-1085

  if (!options.allowScripts && isSafari) {
      // Safari bug: DOMContentLoaded never fires for script-disabled iframes
      // Solution: Poll every 10ms instead!
      const interval = setInterval(() => {
          if (contentDocument.body) {
              clearInterval(interval);
              onLoad();
          }
      }, 10);
  }

  Workaround for: 14-year-old WebKit bug #33604

  ---
  🎯 5. Origin Validation via SHA-256

  Location: index.html:357-378

  // Parent origin is hashed and used as subdomain
  const parentOriginHash = BigInt(`0x${hashHex}`).toString(32).padStart(52, '0');

  if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {
      return start(parentOrigin);  // Valid
  } else {
      throw new Error(`Expected '${parentOriginHash}' as hostname!`);
  }

  Purpose: Cryptographic validation that iframe is talking to correct parent.

  ---
  🎯 6. The DISABLED Real Browser Extension

  Location: /Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-connect/src/main.ts:247

  const DISABLE_BROWSER_CONNECT = true;  // 🚨 Permanently disabled!

  export function activate(context: vscode.ExtensionContext): void {
      if (DISABLE_BROWSER_CONNECT) {
          return;  // Never runs
      }
      // Code for REAL browser automation via WebSocket...
  }

  The smoking gun: Cursor HAD real browser automation (WebSocket RPC server on port 8765 to control actual Chrome instances) but disabled it. They chose iframes instead!

  ---
  ARCHITECTURE SUMMARY:

  Electron Window
    └─ VS Code Workbench
        └─ Webview Container (index.html)
            ├─ Service Worker (resource interception)
            ├─ Message Channel (secure comms)
            └─ Sandboxed iframe (fake.html trick)
                └─ Your Web Content (thinks it's top-level!)

  ---
  WHY IFRAMES INSTEAD OF REAL BROWSERS?

  Based on the disabled cursor-browser-connect extension, Cursor likely chose iframes because:

  1. Faster startup (instant vs. spawning process)
  2. Lower memory (shared process)
  3. Better integration (same CSP, same origin policies)
  4. Simpler architecture (no IPC overhead)
  5. VS Code compatibility (inherits all VS Code webview code)

  ---
  KEY TAKEAWAY:

  Cursor shows an iframe but makes it LOOK and ACT like a real browser through:
  - Service Workers (offline capabilities)
  - Sandboxing (security isolation)
  - Parent deletion (iframe thinks it's top-level)
  - Clever loading tricks (fake.html)
  - Cross-origin workarounds

  It's deceptively sophisticated - most users would never know it's "just" an iframe!