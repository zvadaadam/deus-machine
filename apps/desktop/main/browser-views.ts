/**
 * BrowserView Manager
 *
 * Manages Electron BrowserViews for the agent browser automation feature.
 * Uses native Electron BrowserView APIs for cross-platform web automation.
 *
 * Z-order strategy (same as Cursor/VS Code):
 *   BrowserViews are added via contentView.addChildView(view, 0) which
 *   places them BEHIND the main WebContents. The renderer's DOM (dialogs,
 *   dropdowns, modals) naturally renders on top. The browser content is
 *   visible through the transparent areas of the right panel. This avoids
 *   the classic Electron problem where BrowserViews float above all DOM.
 *
 * Each browser view gets:
 * - Its own session partition (isolated cookies/storage)
 * - A preload script for console capture
 * - Event forwarding (page-load, title, url, navigation)
 * - Network request tracking via session.webRequest
 *
 * Handler names match the snake_case names the renderer calls
 * via invoke(). The preload's browserInvoke() uses "browser:" prefixed names
 * for its own methods, but generic invoke() calls use snake_case.
 */

import { WebContentsView, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";

const views = new Map<string, WebContentsView>();
const viewBounds = new Map<string, Electron.Rectangle>();

/** Reference to the detached browser window (only one at a time) */
let detachedWindow: BrowserWindow | null = null;

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
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) return;

      // Clean up existing view with same label
      const existing = views.get(label);
      if (existing) {
        mainWindow.contentView.removeChildView(existing);
        (existing.webContents as any).destroy?.();
        views.delete(label);
      }

      const bounds = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(Math.max(width, 100)),
        height: Math.round(Math.max(height, 100)),
      };

      const view = new WebContentsView({
        webPreferences: {
          partition: `persist:browser-${label}`,
          contextIsolation: true,
          sandbox: false, // ESM preload (.mjs) requires sandbox: false
          preload: join(__dirname, "../preload/browser-preload.mjs"),
        },
      });

      // Add as a child of contentView. Currently renders on top of main
      // WebContents (same as old BrowserView behavior). To render BEHIND
      // the DOM (like Cursor/VS Code), use addChildView(view, 0) and make
      // the browser panel area transparent — tracked as a follow-up.
      mainWindow.contentView.addChildView(view);
      view.setBounds(bounds);
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

      // Gracefully handle certificate errors for localhost dev servers.
      // Self-signed certs on localhost/127.0.0.1 are accepted — all other
      // cert errors are rejected (navigation will fail).
      view.webContents.on("certificate-error", (event, _url, _error, _certificate, callback) => {
        try {
          const parsed = new URL(_url);
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
            event.preventDefault();
            callback(true); // Accept for localhost
            return;
          }
        } catch {
          // Malformed URL — fall through to reject
        }
        callback(false);
      });

      // Open external links in system browser (only allow http/https)
      view.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
        try {
          const parsed = new URL(linkUrl);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            shell.openExternal(linkUrl);
          }
        } catch {
          // Ignore malformed URLs
        }
        return { action: "deny" };
      });

      // Handle keyboard shortcuts from the browser preload
      view.webContents.on("ipc-message", (_event, channel, data) => {
        if (channel === "browser:keyboard-shortcut") {
          const { shortcut } = data as { shortcut: string };
          if (shortcut === "reload") {
            view.webContents.reload();
          } else if (shortcut === "focus-url-bar") {
            // Forward to renderer so the URL bar can be focused
            mainWindow.webContents.send("browser:keyboard-shortcut", { shortcut });
          }
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
        console.error(`[browser:eval] Error in view "${label}":`, err);
        return null;
      }
    }
  );

  // -------------------------------------------------------------------------
  // JavaScript evaluation (with result capture)
  // Renderer calls: invoke("eval_browser_webview_with_result", { label, js })
  // Used by BrowserTab.tsx for console drain and inspect mode event drain.
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "eval_browser_webview_with_result",
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
      const bounds = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
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
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const view = views.get(label);
    if (mainWindow && view) {
      // Ensure view is in the contentView hierarchy
      const children = mainWindow.contentView.children;
      if (!children.includes(view)) {
        mainWindow.contentView.addChildView(view);
      }
      view.setVisible(true);
      const savedBounds = viewBounds.get(label);
      if (savedBounds) {
        view.setBounds(savedBounds);
      }
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
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.contentView.removeChildView(view);
    }
    (view.webContents as any).destroy?.();
    views.delete(label);
    viewBounds.delete(label);
  });

  ipcMain.handle("reload_browser_webview", (_e, { label }: { label: string }) => {
    views.get(label)?.webContents.reload();
  });

  // -------------------------------------------------------------------------
  // Cookie management (preload browserInvoke calls "browser:cookies:set/get")
  // Keep these with the browser: prefix for the preload's browserInvoke()
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "browser:cookies:set",
    async (_e, { label, cookies }: { label: string; cookies: Electron.CookiesSetDetails[] }) => {
      const ses = views.get(label)?.webContents.session;
      if (!ses) return;
      for (const cookie of cookies) {
        await ses.cookies.set(cookie);
      }
    }
  );

  ipcMain.handle(
    "browser:cookies:get",
    async (_e, { label, url }: { label: string; url: string }) => {
      const ses = views.get(label)?.webContents.session;
      if (!ses) return [];
      return ses.cookies.get({ url });
    }
  );

  // -------------------------------------------------------------------------
  // Get URL / title (preload browserInvoke calls "browser:getURL" / "browser:getTitle")
  // -------------------------------------------------------------------------

  ipcMain.handle("browser:getURL", (_e, { label }: { label: string }) => {
    return views.get(label)?.webContents.getURL() ?? null;
  });

  ipcMain.handle("browser:getTitle", (_e, { label }: { label: string }) => {
    return views.get(label)?.webContents.getTitle() ?? null;
  });

  // -------------------------------------------------------------------------
  // Back / Forward (preload browserInvoke calls "browser:back" / "browser:forward")
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

      detachedWindow.on("closed", () => {
        detachedWindow = null;
        // Notify the main renderer that the detached window was closed
        const mainWindow = BrowserWindow.getAllWindows()[0];
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
  const mainWindow = BrowserWindow.getAllWindows()[0];
  for (const [, view] of views) {
    if (mainWindow) {
      mainWindow.contentView.removeChildView(view);
    }
    (view.webContents as any).destroy?.();
  }
  views.clear();

  if (detachedWindow && !detachedWindow.isDestroyed()) {
    detachedWindow.close();
    detachedWindow = null;
  }
}
