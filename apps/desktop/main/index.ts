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
import { is } from "@electron-toolkit/utils";
import { spawnBackend, stopBackend } from "./backend-process";
// Agent-server is spawned by the backend process (via AGENT_SERVER_BUNDLE_PATH env var)
import { registerNativeHandlers } from "./native-handlers";
import { registerBrowserViewHandlers, destroyAllBrowserViews } from "./browser-views";
// PTY, file watching, and browser server are now handled by the backend
// via WebSocket commands — no Electron IPC needed for these.
import { setupAutoUpdater } from "./auto-updater";
import { syncShellEnvironment } from "./shell-env";
import { setupAppMenu } from "./app-menu";
import { setupTray, destroyTray } from "./tray";

// ---------------------------------------------------------------------------
// Single Instance Lock
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Enable Chrome DevTools Protocol so agent-browser can connect to IDE browser views
// via CDP instead of spawning a separate Chrome process. Listens on 127.0.0.1 only.
// Agent tools use `agent-browser --cdp <port>` to interact with the same browser
// the user sees — shared cookies, real-time visibility of agent actions.
app.commandLine.appendSwitch("remote-debugging-port", "19222");
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
    },
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
  // Debug logging to file (Electron swallows stdout/stderr in dev mode)
  const fs = await import("fs");
  const debugLogPath = join(app.getPath("temp"), "deus-debug.log");
  const debugLog = (msg: string) => {
    try {
      fs.appendFileSync(debugLogPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // Never block boot on diagnostics
    }
    console.error(msg);
  };
  debugLog("[main] App ready, starting initialization...");
  debugLog("[main] __dirname: " + __dirname);

  // Set up the native app menu (File, Edit, View, Window, Help)
  setupAppMenu();
  // Fix PATH when launched from macOS Finder (login shell doesn't run)
  if (process.platform === "darwin") {
    try {
      await syncShellEnvironment();
    } catch (err) {
      debugLog(
        "[main] syncShellEnvironment failed: " + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  // Spawn backend as child process
  debugLog("[main] Spawning backend...");
  try {
    const { port: backendPort, authToken } = await spawnBackend();
    debugLog("[main] Backend started on port: " + backendPort);

    // Expose backend connection info so IPC handlers can return it to renderer
    process.env.DEUS_BACKEND_PORT = String(backendPort);
    process.env.DEUS_AUTH_TOKEN = authToken;

    // System tray icon with backend health status
    setupTray(backendPort);
  } catch (err) {
    debugLog("[main] Backend spawn FAILED: " + (err instanceof Error ? err.message : String(err)));
    const { dialog } = await import("electron");
    dialog.showErrorBox(
      "Failed to Start",
      `The application backend failed to start.\n\n${err instanceof Error ? err.message : String(err)}`
    );
    app.quit();
    return;
  }

  // Agent-server is spawned by the backend process (via AGENT_SERVER_BUNDLE_PATH env var)
  // when AGENT_SERVER_BUNDLE_PATH env var is present.

  // Register IPC handlers before window creation so they're ready immediately
  registerNativeHandlers();
  registerBrowserViewHandlers();

  // Cross-window event relay — when one renderer sends an event via ipcRenderer.send(),
  // forward it to all OTHER windows. This enables the detached browser window to
  // communicate with the main window (e.g., CHAT_INSERT events).
  const RELAY_EVENTS = new Set([
    "chat-insert", // Detached browser -> main window
    "browser-window:workspace-change", // Main window → detached browser window
  ]);

  for (const channel of RELAY_EVENTS) {
    ipcMain.on(channel, (event, ...args) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.id !== event.sender.id && !win.isDestroyed()) {
          win.webContents.send(channel, ...args);
        }
      }
    });
  }

  debugLog("[main] Creating window...");
  // PTY, FS watching, browser server — all handled by backend now

  await createWindow();
  debugLog("[main] Window created");

  // Dev mode: swap dock icon so it's visually distinct from the production app
  if (is.dev && process.platform === "darwin") {
    try {
      const { nativeImage } = await import("electron");
      const devIconPath = join(__dirname, "../../resources/icons/icon-dev.png");
      const devIcon = nativeImage.createFromPath(devIconPath);
      if (!devIcon.isEmpty()) {
        app.dock?.setIcon(devIcon);
        debugLog("[main] Dev dock icon set (orange dot)");
      }
    } catch (err) {
      debugLog(
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
  destroyAllBrowserViews();
  stopBackend();
});

// Export for IPC handlers that need window reference
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
