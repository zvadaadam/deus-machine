/**
 * BrowserView Manager
 *
 * Manages Electron BrowserViews for the agent browser automation feature.
 * Uses native Electron BrowserView APIs for cross-platform web automation.
 *
 * Z-order strategy:
 *   BrowserViews are currently added via contentView.addChildView(view)
 *   which renders them on top of the main WebContents. The renderer hides
 *   all views when dialogs/modals are open to prevent overlap issues.
 *   Rendering behind the DOM via addChildView(view, 0) with a transparent
 *   browser panel is tracked as a follow-up improvement.
 *
 * Each browser view gets:
 * - A shared session partition for cookie persistence across tabs/restarts
 * - A preload script for console capture + keyboard routing
 * - Main-world polyfill injection (WebAuthn, local-network-access)
 * - Event forwarding (page-load, title, url, navigation)
 *
 * Handler names match the snake_case names the renderer calls via invoke().
 * Handlers prefixed "browser:" are invoked via the generic invoke() bridge
 * (back, forward, createDetachedWindow, closeDetachedWindow).
 */

import { WebContentsView, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";

const views = new Map<string, WebContentsView>();
const viewBounds = new Map<string, Electron.Rectangle>();
const viewEmulation = new Map<
  string,
  { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
>();

/** Reference to the detached browser window (only one at a time) */
let detachedWindow: BrowserWindow | null = null;

/** Centralized main window lookup — avoids repeating getAllWindows()[0] in every handler */
function getMainWindow(): BrowserWindow | undefined {
  return (
    BrowserWindow.getAllWindows().find((w) => w !== detachedWindow) ??
    BrowserWindow.getAllWindows()[0]
  );
}

// ---------------------------------------------------------------------------
// Main-world polyfill scripts
//
// These are injected via view.webContents.executeJavaScript() on `dom-ready`
// so they run in the page's main world. The preload's webFrame.executeJavaScript()
// runs in the isolated world and cannot override page-visible APIs like
// navigator.credentials or navigator.permissions.
// ---------------------------------------------------------------------------

const WEBAUTHN_POLYFILL_JS = `(function() {
  if (typeof navigator === 'undefined' || !navigator.credentials) return;
  if (navigator.credentials.__webAuthnPolyfillApplied) return;
  navigator.credentials.__webAuthnPolyfillApplied = true;

  function createNotSupportedError() {
    return new DOMException('WebAuthn is not supported in the Deus browser. Click "Try another way" to use password login.', 'NotSupportedError');
  }

  var origCreate = navigator.credentials.create;
  var origGet = navigator.credentials.get;

  // Reject passkey/FIDO2 requests immediately so sites fall back to
  // password login. Wrapping the original method with a 45s timeout
  // just makes users wait — rejecting instantly shows the fallback UI.
  navigator.credentials.create = function(options) {
    if (options && options.publicKey) return Promise.reject(createNotSupportedError());
    return origCreate ? origCreate.apply(navigator.credentials, arguments) : Promise.reject(createNotSupportedError());
  };
  navigator.credentials.get = function(options) {
    if (options && options.publicKey) return Promise.reject(createNotSupportedError());
    return origGet ? origGet.apply(navigator.credentials, arguments) : Promise.reject(createNotSupportedError());
  };

  if (typeof PublicKeyCredential !== 'undefined') {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function() {
      return Promise.resolve(false);
    };
    if (typeof PublicKeyCredential.isConditionalMediationAvailable === 'function') {
      PublicKeyCredential.isConditionalMediationAvailable = function() {
        return Promise.resolve(false);
      };
    }
  }
})();`;

const LOCAL_NETWORK_POLYFILL_JS = `(function() {
  if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return;
  if (navigator.permissions.__localNetworkPolyfillApplied) return;
  navigator.permissions.__localNetworkPolyfillApplied = true;

  var origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function(descriptor) {
    if (descriptor && (descriptor.name === 'local-network-access' || descriptor.name === 'local-network')) {
      return Promise.resolve({
        state: 'granted',
        name: descriptor.name,
        onchange: null,
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; }
      });
    }
    return origQuery(descriptor);
  };
})();`;

const AUTH_DOMAINS = [
  ".okta.com",
  ".okta-emea.com",
  ".oktapreview.com",
  ".duosecurity.com",
  ".duo.com",
  ".login.microsoftonline.com",
  ".onelogin.com",
  ".auth0.com",
  ".pingidentity.com",
  ".pingone.com",
  ".rippling.com",
];

/**
 * Create a hidden BrowserView as a CDP target for agent-browser.
 *
 * Without this, agent-browser connects to CDP port 19222, finds only
 * localhost:1420 (the Electron renderer) as a page target, and navigates
 * it — replacing the entire app UI with the target URL.
 *
 * This view stays permanently hidden with zero bounds. It exists only
 * so agent-browser has a non-renderer page target to connect to via CDP.
 * Agent-browser gets page content through CDP snapshots/screenshots —
 * no visual rendering needed. The frontend's BrowserPanel handles the
 * user-facing browser UI separately.
 */
export function ensureDefaultBrowserView(): void {
  const mainWindow = getMainWindow();
  if (!mainWindow || views.has("__default")) return;

  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:browser",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "../preload/browser-preload.mjs"),
    },
  });

  // Permanently hidden — exists only as a CDP target
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  views.set("__default", view);

  // Load a data: URL (not about:blank) so agent-browser's target filter
  // includes it. agent-browser skips about: and chrome:// URLs.
  view.webContents.loadURL("data:text/html,<title>deus-browser</title>");
}

export function registerBrowserViewHandlers(): void {
  // -------------------------------------------------------------------------
  // Create a new browser view
  // Renderer calls: invoke("create_browser_webview", { label, url, x, y, width, height, windowLabel })
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "create_browser_webview",
    (
      _e,
      {
        label,
        url,
        x,
        y,
        width,
        height,
      }: {
        label: string;
        url: string;
        x: number;
        y: number;
        width: number;
        height: number;
        windowLabel?: string;
      }
    ) => {
      const mainWindow = getMainWindow();
      if (!mainWindow) return;

      // Clean up existing view with same label
      const existing = views.get(label);
      if (existing) {
        mainWindow.contentView.removeChildView(existing);
        (existing.webContents as any).destroy?.();
        views.delete(label);
        viewBounds.delete(label);
        viewEmulation.delete(label);
      }

      // getBoundingClientRect() returns CSS-pixel coordinates, but
      // WebContentsView.setBounds() operates in the window's native coordinate
      // space. When the user zooms the renderer (Cmd+/Cmd-), CSS pixels diverge
      // from window points by the zoom factor — multiply to correct.
      const zoomFactor = mainWindow.webContents.getZoomFactor();
      const bounds = {
        x: Math.round(x * zoomFactor),
        y: Math.round(y * zoomFactor),
        width: Math.round(Math.max(width * zoomFactor, 100)),
        height: Math.round(Math.max(height * zoomFactor, 100)),
      };

      const view = new WebContentsView({
        webPreferences: {
          // Single shared partition — all tabs share cookies like a real browser.
          // Login once on localhost:3000, every tab sees it. Persists across restarts.
          partition: "persist:browser",
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          sandbox: false, // ESM preload (.mjs) requires sandbox: false — TODO: convert to CJS
          webviewTag: false,
          navigateOnDragDrop: false,
          enableBlinkFeatures: "StandardizedBrowserZoom",
          preload: join(__dirname, "../preload/browser-preload.mjs"),
        },
      });

      // Set bounds BEFORE adding to hierarchy to prevent fullscreen flash.
      // addChildView without prior setBounds renders at full window size.
      view.setBounds(bounds);
      mainWindow.contentView.addChildView(view);
      views.set(label, view);

      // Register event listeners BEFORE loadURL to avoid race conditions.
      // loadURL() triggers loading events that must be captured.
      //
      // Event semantics:
      //   did-start-loading  — any frame starts (main + iframes/ads)
      //   did-stop-loading   — ALL frames finished (tab spinner stops)
      //   did-finish-load    — main frame only
      //   did-fail-load      — main frame navigation failure
      //
      // We use did-start-loading + did-stop-loading to match browser tab
      // spinner behavior. did-finish-load fires before subresources are
      // done, and did-start-loading fires for iframes too — using
      // did-stop-loading as "finished" ensures loading state clears once
      // everything is truly done (no stuck spinner from ad iframes).
      view.webContents.on("did-start-loading", () => {
        mainWindow.webContents.send("browser:page-load", {
          label,
          url: view.webContents.getURL(),
          event: "started",
        });
      });

      view.webContents.on("did-stop-loading", () => {
        mainWindow.webContents.send("browser:page-load", {
          label,
          url: view.webContents.getURL(),
          event: "finished",
        });
      });

      view.webContents.on(
        "did-fail-load",
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
          // Only report main frame failures — subframe failures (ads, iframes)
          // shouldn't show as page-level errors.
          // ERR_ABORTED (-3) fires during redirects and canceled navigations — not a real failure.
          if (!isMainFrame || errorCode === -3) return;
          mainWindow.webContents.send("browser:page-load", {
            label,
            url: view.webContents.getURL(),
            event: "failed",
            error: { code: errorCode, description: errorDescription },
          });
        }
      );

      view.webContents.on("page-title-updated", (_, title) => {
        mainWindow.webContents.send("browser:title-changed", { label, title });
      });

      view.webContents.on("did-navigate", () => {
        mainWindow.webContents.send("browser:url-change", {
          label,
          url: view.webContents.getURL(),
        });
      });

      view.webContents.on("did-navigate-in-page", () => {
        mainWindow.webContents.send("browser:url-change", {
          label,
          url: view.webContents.getURL(),
        });
      });

      // TODO: Network request tracking — disabled until renderer listener is wired.
      // The events were being sent but nothing consumed them (wasted IPC traffic).

      // Certificate error handling — only accept self-signed certs on localhost
      // in development mode. Production builds reject all cert errors.
      view.webContents.on("certificate-error", (event, _url, _error, _certificate, callback) => {
        if (is.dev) {
          try {
            const parsed = new URL(_url);
            if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
              event.preventDefault();
              callback(true);
              return;
            }
          } catch {
            // Malformed URL — fall through to reject
          }
        }
        callback(false);
      });

      // Handle popups (window.open, target="_blank", OAuth flows).
      // Instead of opening in the system browser (which breaks OAuth callbacks),
      // forward to the renderer so it opens as a new browser tab in the IDE.
      // This matches how Cursor handles it — popup stays in-app, cookies are shared.
      view.webContents.setWindowOpenHandler(({ url: linkUrl, disposition }) => {
        try {
          const parsed = new URL(linkUrl);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            // Send to renderer to open as a new browser tab
            mainWindow.webContents.send("browser:new-tab-requested", {
              url: linkUrl,
              disposition, // "foreground-tab", "background-tab", "new-window"
              openerLabel: label,
            });
          }
        } catch {
          // Ignore malformed URLs
        }
        return { action: "deny" };
      });

      // Handle messages from the browser preload (keyboard shortcuts + console)
      view.webContents.on("ipc-message", (_event, channel, ...args) => {
        if (channel === "browser:keyboard-shortcut") {
          const payload = args[0];
          if (!payload || typeof payload !== "object") return;
          const { shortcut } = payload as { shortcut: string };
          if (shortcut === "reload") {
            view.webContents.reload();
          } else if (shortcut === "focus-url-bar") {
            // Forward to renderer so the URL bar can be focused
            mainWindow.webContents.send("browser:keyboard-shortcut", { shortcut });
          }
        } else if (channel === "browser:console-message") {
          // Forward console messages from browser views to the renderer
          mainWindow.webContents.send("browser:console-message", args[0]);
        }
      });

      // Inject polyfills into the page's main world.
      // WebAuthn must run BEFORE page scripts — use did-start-navigation so it
      // executes before any site JS checks PublicKeyCredential availability.
      // dom-ready is too late: Google's auth JS runs during parsing.
      view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;
        // WebAuthn polyfill — immediate rejection for passkey/FIDO2 requests
        view.webContents.executeJavaScript(WEBAUTHN_POLYFILL_JS).catch(() => {});
      });

      // Local network polyfill needs the final URL (after redirects), so use dom-ready
      view.webContents.on("dom-ready", () => {
        try {
          const pageUrl = view.webContents.getURL();
          const hostname = new URL(pageUrl).hostname.toLowerCase();
          if (AUTH_DOMAINS.some((d) => hostname === d.slice(1) || hostname.endsWith(d))) {
            view.webContents.executeJavaScript(LOCAL_NETWORK_POLYFILL_JS).catch(() => {});
          }
        } catch {
          /* malformed URL — skip polyfill */
        }
      });

      // Start navigation AFTER all listeners are attached
      view.webContents.loadURL(url);
    }
  );

  // -------------------------------------------------------------------------
  // Navigation
  // Renderer calls: invoke("navigate_browser_webview", { label, url })
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "navigate_browser_webview",
    (_e, { label, url }: { label: string; url: string }) => {
      views.get(label)?.webContents.loadURL(url);
    }
  );

  // -------------------------------------------------------------------------
  // JavaScript evaluation (fire-and-forget)
  // Renderer calls: invoke("eval_browser_webview", { label, js })
  // Used by BrowserTab.tsx to inject automation scripts into the webview.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "eval_browser_webview",
    async (_e, { label, js }: { label: string; js: string }) => {
      const view = views.get(label);
      if (!view) return null;
      try {
        return await view.webContents.executeJavaScript(js);
      } catch (err) {
        console.error(`[BrowserView] eval failed for "${label}":`, err);
        return null;
      }
    }
  );

  // -------------------------------------------------------------------------
  // JavaScript evaluation (with result capture + timeout)
  // Renderer calls: invoke("eval_browser_webview_with_result", { label, js, timeout_ms })
  // Used by BrowserTab.tsx for console drain and inspect mode event drain.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "eval_browser_webview_with_result",
    async (_e, { label, js, timeout_ms }: { label: string; js: string; timeout_ms?: number }) => {
      const view = views.get(label);
      if (!view) return null;
      try {
        const timeout = timeout_ms ?? 30_000;
        return await Promise.race([
          view.webContents.executeJavaScript(js),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Eval timeout")), timeout)
          ),
        ]);
      } catch (err) {
        console.error(`[BrowserView] eval failed for "${label}":`, err);
        return null;
      }
    }
  );

  // -------------------------------------------------------------------------
  // Screenshot
  // Renderer calls: invoke("screenshot_browser_webview", { label, x?, y?, width?, height? })
  // Supports optional crop rectangle; omit for full page capture.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "screenshot_browser_webview",
    async (
      _e,
      {
        label,
        x,
        y,
        width,
        height,
      }: {
        label: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }
    ) => {
      const view = views.get(label);
      if (!view) return null;
      try {
        let image;
        if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
          image = await view.webContents.capturePage({
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
          });
        } else {
          image = await view.webContents.capturePage();
        }
        return image.toDataURL();
      } catch (err) {
        console.error(`[BrowserView] screenshot failed for "${label}":`, err);
        return null;
      }
    }
  );

  // -------------------------------------------------------------------------
  // DevTools
  // Renderer calls: invoke("open_browser_devtools", { label })
  //                 invoke("close_browser_devtools", { label })
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "open_browser_devtools",
    (_e, { label, mode }: { label: string; mode?: "right" | "bottom" | "detach" | "undocked" }) => {
      views.get(label)?.webContents.openDevTools({ mode: mode ?? "bottom" });
    }
  );

  ipcMain.handle("close_browser_devtools", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (view?.webContents.isDevToolsOpened()) {
      view.webContents.closeDevTools();
    }
  });

  // -------------------------------------------------------------------------
  // Bounds / visibility
  // Renderer calls: invoke("set_browser_webview_bounds", { label, x, y, width, height })
  //                 invoke("show_browser_webview", { label })
  //                 invoke("hide_browser_webview", { label })
  //                 invoke("close_browser_webview", { label })
  //                 invoke("reload_browser_webview", { label })
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "set_browser_webview_bounds",
    (
      _e,
      {
        label,
        x,
        y,
        width,
        height,
      }: {
        label: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }
    ) => {
      // CSS-pixel → window-point conversion (see create_browser_webview comment)
      const mainWindow = getMainWindow();
      const zoomFactor = mainWindow?.webContents.getZoomFactor() ?? 1;
      const bounds = {
        x: Math.round(x * zoomFactor),
        y: Math.round(y * zoomFactor),
        width: Math.round(width * zoomFactor),
        height: Math.round(height * zoomFactor),
      };
      const view = views.get(label);
      if (view) {
        view.setBounds(bounds);
        // Also save to viewBounds so show() uses the latest position
        // (important when setBounds is called while the view is hidden/detached)
        viewBounds.set(label, bounds);
      }
    }
  );

  ipcMain.handle("show_browser_webview", (_e, { label }: { label: string }) => {
    const mainWindow = getMainWindow();
    const view = views.get(label);
    if (mainWindow && view) {
      // Apply bounds BEFORE adding to hierarchy or making visible.
      // addChildView without prior setBounds renders the view at full
      // window size for one frame, causing a fullscreen flash.
      const savedBounds = viewBounds.get(label);
      if (savedBounds) {
        view.setBounds(savedBounds);
      }
      const children = mainWindow.contentView.children;
      if (!children.includes(view)) {
        mainWindow.contentView.addChildView(view);
      }
      view.setVisible(true);
    }
  });

  ipcMain.handle("hide_browser_webview", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (view) {
      viewBounds.set(label, view.getBounds());
      view.setVisible(false);
    }
  });

  // Hide ALL browser views at once — called when switching workspaces
  // or navigating to the welcome screen to ensure no stale native overlays.
  ipcMain.handle("hide_all_browser_webviews", () => {
    for (const [label, view] of views) {
      viewBounds.set(label, view.getBounds());
      view.setVisible(false);
    }
  });

  ipcMain.handle("close_browser_webview", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (!view) return;
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.contentView.removeChildView(view);
    }
    (view.webContents as any).destroy?.();
    views.delete(label);
    viewBounds.delete(label);
    viewEmulation.delete(label);
  });

  ipcMain.handle("reload_browser_webview", (_e, { label }: { label: string }) => {
    views.get(label)?.webContents.reload();
  });

  // -------------------------------------------------------------------------
  // View existence check (used by try-recall-before-create pattern)
  // -------------------------------------------------------------------------

  ipcMain.handle("browser_view_exists", (_e, { label }: { label: string }) => {
    return views.has(label);
  });

  // -------------------------------------------------------------------------
  // Device emulation (CDP Emulation domain via webContents.debugger)
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "set_browser_emulation",
    async (
      _e,
      {
        label,
        width,
        height,
        deviceScaleFactor,
        mobile,
        scale,
      }: {
        label: string;
        width: number;
        height: number;
        deviceScaleFactor: number;
        mobile: boolean;
        scale?: number;
      }
    ) => {
      const view = views.get(label);
      if (!view) return { success: false, error: "View not found" };

      try {
        if (!view.webContents.debugger.isAttached()) {
          view.webContents.debugger.attach("1.3");
        }

        if (scale !== undefined && scale < 1) {
          // Oversized viewport — setDeviceMetricsOverride and setZoomFactor
          // conflict (they both affect the layout viewport). Use zoom alone:
          // innerWidth = physicalWidth / zoomFactor = desiredWidth.
          // Clear any previous CDP override first.
          await view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride", {});
          view.webContents.setZoomFactor(scale);
        } else {
          // Viewport fits in panel — use CDP for proper device emulation
          // (exact dimensions, DPR, mobile flag).
          await view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
            width,
            height,
            deviceScaleFactor,
            mobile,
          });
          view.webContents.setZoomFactor(1);
        }

        // Touch emulation works independently of device metrics.
        // maxTouchPoints must be 1-16; omit when disabling.
        await view.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled: mobile,
          ...(mobile ? { maxTouchPoints: 5 } : {}),
        });

        viewEmulation.set(label, { width, height, deviceScaleFactor, mobile });
        return { success: true };
      } catch (err) {
        console.error(`[BrowserView] set_browser_emulation failed for "${label}":`, err);
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle("clear_browser_emulation", async (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (!view) return { success: false, error: "View not found" };

    try {
      if (view.webContents.debugger.isAttached()) {
        await view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride", {});
        await view.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled: false,
        });
      }
      view.webContents.setZoomFactor(1);
      viewEmulation.delete(label);
      return { success: true };
    } catch (err) {
      console.error(`[BrowserView] clear_browser_emulation failed for "${label}":`, err);
      return { success: false, error: String(err) };
    }
  });

  // -------------------------------------------------------------------------
  // Back / Forward
  // -------------------------------------------------------------------------

  ipcMain.handle("browser:back", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (view?.webContents.canGoBack()) {
      view.webContents.goBack();
    }
  });

  ipcMain.handle("browser:forward", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (view?.webContents.canGoForward()) {
      view.webContents.goForward();
    }
  });

  // -------------------------------------------------------------------------
  // Detached Browser Window
  // Renderer calls: invoke("browser:createDetachedWindow", { url, title, width, height, minWidth, minHeight })
  //                 invoke("browser:closeDetachedWindow")
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "browser:createDetachedWindow",
    (
      _e,
      {
        url,
        title,
        width,
        height,
        minWidth,
        minHeight,
      }: {
        url: string;
        title: string;
        width: number;
        height: number;
        minWidth?: number;
        minHeight?: number;
      }
    ) => {
      // Close existing detached window if any
      if (detachedWindow && !detachedWindow.isDestroyed()) {
        detachedWindow.close();
        detachedWindow = null;
      }

      detachedWindow = new BrowserWindow({
        width,
        height,
        minWidth: minWidth ?? 600,
        minHeight: minHeight ?? 400,
        title,
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        trafficLightPosition: { x: 16, y: 18 },
        webPreferences: {
          preload: join(__dirname, "../preload/index.mjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false, // ESM preload (index.mjs) requires sandbox: false
        },
      });

      // Load the renderer app with the detached window URL
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        detachedWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}${url}`);
      } else {
        detachedWindow.loadFile(join(__dirname, "../renderer/index.html"), {
          search: url.includes("?") ? url.split("?")[1] : "",
        });
      }

      // Register close handler immediately after creation (before loadURL completes)
      // to prevent race conditions where the window closes before the listener is attached.
      detachedWindow.on("closed", () => {
        detachedWindow = null;
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send("browser:detached-closed");
        }
      });
    }
  );

  ipcMain.handle("browser:closeDetachedWindow", () => {
    if (detachedWindow && !detachedWindow.isDestroyed()) {
      detachedWindow.close();
      detachedWindow = null;
    }
  });
}

/**
 * Clean up all browser views. Called on app quit.
 */
export function destroyAllBrowserViews(): void {
  const mainWindow = getMainWindow();
  for (const [, view] of views) {
    if (mainWindow) {
      mainWindow.contentView.removeChildView(view);
    }
    (view.webContents as any).destroy?.();
  }
  views.clear();
  viewBounds.clear();
  viewEmulation.clear();

  if (detachedWindow && !detachedWindow.isDestroyed()) {
    detachedWindow.close();
    detachedWindow = null;
  }
}
