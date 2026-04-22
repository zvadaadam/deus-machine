/**
 * Electron Main Process — Thin Shell
 *
 * Responsibilities:
 * - Window lifecycle (create, show, close)
 * - Backend child process management
 * - IPC handler registration
 * - Auto-updater setup
 * - Shell environment sync (macOS PATH fix)
 *
 * Business logic stays in the Node.js backend and agent-server — the main process
 * is purely a desktop shell that spawns them and bridges native OS features.
 */

import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import { homedir } from "os";
import { is } from "@electron-toolkit/utils";
import { spawnBackend, stopBackend, CDP_PORT } from "./backend-process";
import { registerNativeHandlers } from "./native-handlers";
import { registerBrowserEmulationHandlers } from "./browser-emulation";
// PTY, file watching, and browser server are now handled by the backend
// via WebSocket commands — no Electron IPC needed for these.
import { setupAutoUpdater } from "./auto-updater";
import { syncShellEnvironment } from "./shell-env";
import { setupAppMenu } from "./app-menu";
import { setupTray, destroyTray } from "./tray";
import { ensureInstalledInApplications } from "./install-preflight";
import {
  formatStartupFailureDetail,
  getMainLogPath,
  initMainProcessLogging,
  logMainProcess,
} from "./startup-diagnostics";
import { resolveDefaultDataDir } from "../../../shared/runtime";

// ---------------------------------------------------------------------------
// Single Instance Lock
// ---------------------------------------------------------------------------

const canonicalUserDataPath = resolveDefaultDataDir({
  platform: process.platform,
  homeDir: process.env.HOME || homedir(),
  appData: process.env.APPDATA,
  xdgDataHome: process.env.XDG_DATA_HOME,
});
app.setPath("userData", canonicalUserDataPath);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Enable Chrome DevTools Protocol so agent-browser can connect to IDE browser views
// via CDP instead of spawning a separate Chrome process. Listens on 127.0.0.1 only.
// Agent tools use `agent-browser --cdp <port>` to interact with the same browser
// the user sees — shared cookies, real-time visibility of agent actions.
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Window Creation
// ---------------------------------------------------------------------------

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#0e0e10",
    // Vibrancy is set dynamically via IPC after onboarding completes.
    // No transparent:true — the CSS overlay handles the dark onboarding canvas,
    // and vibrancy works without native transparency.
    ...(process.platform === "linux"
      ? { icon: join(__dirname, "../../resources/icons/icon.png") }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // ESM preload requires sandbox: false (package.json "type": "module")
      webviewTag: true, // Phase 1 of WebContentsView→<webview> migration — enables <webview> for guest pages
    },
  });

  // Attach the guest-page preload whenever a <webview> element is mounted.
  // The <webview> tag itself sets `partition` so all tabs share the
  // `persist:browser` cookie jar; here we only wire the preload + isolation.
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.preload = join(__dirname, "../preload/browser-preload.mjs");
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
  });

  // Keep popups in-app: when a guest calls window.open() or follows a
  // `target="_blank"` link (common for OAuth redirects), forward the URL to
  // the renderer which will open it as a new browser tab. Returning
  // `{ action: "deny" }` stops Electron from spawning a standalone window.
  //
  // SECURITY: restrict forwarded URLs to http/https. `data:`, `javascript:`,
  // `file:`, and `chrome:` schemes could be used to inject arbitrary code
  // into the `persist:browser` partition, which is shared across tabs and
  // inherits cookies from every legitimate site. Any non-http(s) scheme is
  // silently dropped; the renderer never sees it, no new tab is spawned.
  mainWindow.webContents.on("did-attach-webview", (_event, guestContents) => {
    guestContents.setWindowOpenHandler(({ url, disposition }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { action: "deny" };
        }
      } catch {
        // Unparseable URL — deny silently.
        return { action: "deny" };
      }
      mainWindow?.webContents.send("browser:new-tab-requested", { url, disposition });
      return { action: "deny" };
    });
  });

  // Show window once renderer is ready (avoids white flash)
  mainWindow.on("ready-to-show", () => {
    // Window starts hidden — the renderer calls show_main_window after
    // settings/onboarding state is determined.
    // Safety net: force-show after 3s if the renderer hasn't called show_main_window.
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log("[main] Safety net: force-showing window after 3s timeout");
        mainWindow.show();
      }
    }, 3000);
  });

  // Open DevTools in development
  if (is.dev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Forward renderer console to main process stdout (dev only — avoid leaking PII in prod logs)
  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      const prefix =
        level === 2 ? "[renderer:warn]" : level === 3 ? "[renderer:error]" : "[renderer]";
      const source = sourceId ? ` (${sourceId.split("/").pop()}:${line})` : "";
      console.log(`${prefix} ${message}${source}`);
    });
  }

  // External links open in system browser (only allow http/https)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // Ignore malformed URLs
    }
    return { action: "deny" };
  });

  // Block top-level navigation to external URLs (security: prevent redirect hijacks)
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const appUrl = is.dev
      ? process.env.ELECTRON_RENDERER_URL
      : `file://${join(__dirname, "../renderer")}`;
    if (appUrl && url.startsWith(appUrl)) return; // allow app navigation
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed */
    }
  });

  // Track fullscreen state for CSS selectors (.fullscreen)
  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("fullscreen-change", { isFullscreen: true });
  });
  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("fullscreen-change", { isFullscreen: false });
  });

  // Dev: load Vite dev server. Prod: load built files.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---------------------------------------------------------------------------
// App Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  initMainProcessLogging();
  logMainProcess("[main] App ready, starting initialization...");
  logMainProcess("[main] __dirname: " + __dirname);

  if (await ensureInstalledInApplications()) {
    return;
  }

  // Set up the native app menu (File, Edit, View, Window, Help)
  setupAppMenu();
  // Fix PATH when launched from macOS Finder (login shell doesn't run)
  if (process.platform === "darwin") {
    try {
      await syncShellEnvironment();
    } catch (err) {
      logMainProcess(
        "[main] syncShellEnvironment failed: " + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // Spawn runtime children as child processes
  logMainProcess("[main] Spawning runtime stack...");
  try {
    const { port: backendPort, authToken } = await spawnBackend({
      onStdoutLine: (source, line) => {
        if (source === "backend" && line.startsWith("DEUS_WORKSPACE_PROGRESS:")) {
          return;
        }
        logMainProcess(`[${source}] ${line}`);
      },
      onStderrLine: (source, line) => {
        logMainProcess(`[${source}:stderr] ${line}`);
      },
      onExit: (source, code, signal) => {
        logMainProcess(`[${source}] Exited with code=${code} signal=${signal}`);
      },
    });
    logMainProcess("[main] Backend started on port: " + backendPort);

    // Expose backend connection info so IPC handlers can return it to renderer
    process.env.DEUS_BACKEND_PORT = String(backendPort);
    process.env.DEUS_AUTH_TOKEN = authToken;

    // System tray icon with backend health status
    setupTray(backendPort);
  } catch (err) {
    logMainProcess(
      "[main] Backend spawn FAILED: " + (err instanceof Error ? err.message : String(err))
    );
    const { dialog } = await import("electron");
    const { response } = await dialog.showMessageBox({
      type: "error",
      buttons: ["Show Logs", "OK"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: "Failed to Start",
      detail: formatStartupFailureDetail(err),
    });
    if (response === 0) {
      shell.showItemInFolder(getMainLogPath());
    }
    app.quit();
    return;
  }

  // Electron owns both runtime children directly: agent-server first, then backend.

  // Register IPC handlers before window creation so they're ready immediately
  registerNativeHandlers();
  registerBrowserEmulationHandlers();

  // Cross-window event relay — forwards a sender's event to all other windows.
  // Used for chat-insert (e.g. terminal/simulator feeding the main composer).
  const RELAY_EVENTS = new Set(["chat-insert"]);

  for (const channel of RELAY_EVENTS) {
    ipcMain.on(channel, (event, ...args) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.id !== event.sender.id && !win.isDestroyed()) {
          win.webContents.send(channel, ...args);
        }
      }
    });
  }

  logMainProcess("[main] Creating window...");
  // PTY, FS watching, browser server — all handled by backend now

  await createWindow();
  logMainProcess("[main] Window created");

  // Dev mode: swap dock icon so it's visually distinct from the production app
  if (is.dev && process.platform === "darwin") {
    try {
      const { nativeImage } = await import("electron");
      const devIconPath = join(__dirname, "../../resources/icons/icon-dev.png");
      const devIcon = nativeImage.createFromPath(devIconPath);
      if (!devIcon.isEmpty()) {
        app.dock?.setIcon(devIcon);
        logMainProcess("[main] Dev dock icon set (orange dot)");
      }
    } catch (err) {
      logMainProcess(
        "[main] Failed to set dev dock icon: " + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // Auto-updater (delayed start — let the app boot first)
  if (!is.dev) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) setupAutoUpdater(mainWindow);
    }, 15_000);
  }
});

// Second instance: focus existing window
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Quit when all windows are closed (all platforms including macOS)
app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  destroyTray();
  stopBackend();
});

// Export for IPC handlers that need window reference
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
