/**
 * BrowserView Manager
 *
 * Manages Electron BrowserViews for the agent browser automation feature.
 * Uses native Electron BrowserView APIs for cross-platform web automation.
 *
 * Each browser view gets:
 * - Its own session partition (isolated cookies/storage)
 * - A preload script for console capture
 * - Event forwarding (page-load, title, url, navigation)
 * - Network request tracking via session.webRequest
 *
 * Handler names match the Tauri-style snake_case names the renderer calls
 * via invoke(). The preload's browserInvoke() uses "browser:" prefixed names
 * for its own methods, but generic invoke() calls use snake_case.
 */

import { BrowserView, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";

const views = new Map<string, BrowserView>();

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
        mainWindow.removeBrowserView(existing);
        (existing.webContents as any).destroy?.();
        views.delete(label);
      }

      const bounds = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(Math.max(width, 100)),
        height: Math.round(Math.max(height, 100)),
      };

      const view = new BrowserView({
        webPreferences: {
          partition: `persist:browser-${label}`,
          contextIsolation: true,
          sandbox: true,
          preload: join(__dirname, "../preload/browser-preload.mjs"),
        },
      });

      mainWindow.addBrowserView(view);
      view.setBounds(bounds);
      view.setAutoResize({ width: false, height: false });
      view.webContents.loadURL(url);
      views.set(label, view);

      // Forward navigation events to renderer
      view.webContents.on("did-start-loading", () => {
        mainWindow.webContents.send("browser:page-load", {
          label,
          url: view.webContents.getURL(),
          event: "started",
        });
      });

      view.webContents.on("did-finish-load", () => {
        mainWindow.webContents.send("browser:page-load", {
          label,
          url: view.webContents.getURL(),
          event: "finished",
        });
      });

      view.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
        mainWindow.webContents.send("browser:page-load", {
          label,
          url: view.webContents.getURL(),
          event: "failed",
          error: { code: errorCode, description: errorDescription },
        });
      });

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

      // Network request tracking
      const ses = view.webContents.session;
      ses.webRequest.onCompleted((details) => {
        mainWindow.webContents.send("browser:network-request", {
          label,
          url: details.url,
          method: details.method,
          statusCode: details.statusCode,
          resourceType: details.resourceType,
          fromCache: details.fromCache,
        });
      });

      // Open external links in system browser
      view.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
        const { shell } = require("electron");
        shell.openExternal(linkUrl);
        return { action: "deny" };
      });
    }
  );

  // -------------------------------------------------------------------------
  // Navigation
  // Renderer calls: invoke("navigate_browser_webview", { label, url })
  // -------------------------------------------------------------------------

  ipcMain.handle("navigate_browser_webview", (_e, { label, url }: { label: string; url: string }) => {
    views.get(label)?.webContents.loadURL(url);
  });

  // -------------------------------------------------------------------------
  // JavaScript evaluation
  // Renderer calls: invoke("eval_browser_webview", { label, js })
  // Returns the result of the JS execution (used by eval-with-result.ts)
  // -------------------------------------------------------------------------

  ipcMain.handle("eval_browser_webview", async (_e, { label, js }: { label: string; js: string }) => {
    const view = views.get(label);
    if (!view) return null;
    try {
      return await view.webContents.executeJavaScript(js);
    } catch (err) {
      console.error(`[browser:eval] Error in view "${label}":`, err);
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // Screenshot
  // Renderer calls: invoke("screenshot_browser_webview", { label })
  // -------------------------------------------------------------------------

  ipcMain.handle("screenshot_browser_webview", async (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (!view) return null;
    try {
      const image = await view.webContents.capturePage();
      return image.toJPEG(85).toString("base64");
    } catch (err) {
      console.error(`[browser:screenshot] Error in view "${label}":`, err);
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // DevTools
  // Renderer calls: invoke("open_browser_devtools", { label })
  //                 invoke("close_browser_devtools", { label })
  // -------------------------------------------------------------------------

  ipcMain.handle("open_browser_devtools", (_e, { label }: { label: string }) => {
    views.get(label)?.webContents.openDevTools({ mode: "detach" });
  });

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
      views.get(label)?.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      });
    }
  );

  ipcMain.handle("show_browser_webview", (_e, { label }: { label: string }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const view = views.get(label);
    if (mainWindow && view) {
      // Re-add if it was removed (hidden)
      if (!mainWindow.getBrowserViews().includes(view)) {
        mainWindow.addBrowserView(view);
      }
    }
  });

  ipcMain.handle("hide_browser_webview", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (view) {
      // Hide by setting zero-size bounds
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  });

  ipcMain.handle("close_browser_webview", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (!view) return;
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.removeBrowserView(view);
    }
    (view.webContents as any).destroy?.();
    views.delete(label);
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
  // Console message capture (preload browserInvoke calls "browser:getConsoleMessages")
  // -------------------------------------------------------------------------

  ipcMain.handle("browser:getConsoleMessages", (_e, { label }: { label: string }) => {
    const view = views.get(label);
    if (!view) return [];
    return []; // TODO: buffer recent messages from preload forwarding
  });

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
          sandbox: true,
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
      mainWindow.removeBrowserView(view);
    }
    (view.webContents as any).destroy?.();
  }
  views.clear();

  if (detachedWindow && !detachedWindow.isDestroyed()) {
    detachedWindow.close();
    detachedWindow = null;
  }
}
