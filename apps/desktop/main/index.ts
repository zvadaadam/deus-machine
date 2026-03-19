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
 * Business logic stays in the Node.js backend and sidecar — the main process
 * is purely a desktop shell that spawns them and bridges native OS features.
 */

import { app, BrowserWindow, shell } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import { spawnBackend, stopBackend } from "./backend-process";
// Sidecar is now spawned and managed by the backend (sidecar.service.ts)
import { registerNativeHandlers } from "./native-handlers";
import { registerBrowserViewHandlers, destroyAllBrowserViews } from "./browser-views";
// PTY, file watching, and browser server are now handled by the backend
// via WebSocket commands — no Electron IPC needed for these.
import { setupAutoUpdater } from "./auto-updater";
import { syncShellEnvironment } from "./shell-env";

// ---------------------------------------------------------------------------
// Single Instance Lock
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

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
    backgroundColor: "#00000000",
    transparent: process.platform === "darwin",
    vibrancy: process.platform === "darwin" ? "under-window" : undefined,
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
      if (mainWindow && !mainWindow.isVisible()) {
        console.log("[main] Safety net: force-showing window after 3s timeout");
        mainWindow.show();
      }
    }, 3000);
  });

  // Open DevTools in development
  if (process.env.NODE_ENV !== "production" || !app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Forward renderer console to main process stdout (for debugging)
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const prefix =
      level === 2 ? "[renderer:warn]" : level === 3 ? "[renderer:error]" : "[renderer]";
    const source = sourceId ? ` (${sourceId.split("/").pop()}:${line})` : "";
    console.log(`${prefix} ${message}${source}`);
  });

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
  const debugLogPath = join(app.getPath("temp"), "opendevs-debug.log");
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
  // Fix PATH when launched from macOS Finder (login shell doesn't run)
  if (process.platform === "darwin") {
    await syncShellEnvironment();
  }

  // Spawn backend as child process
  debugLog("[main] Spawning backend...");
  try {
    const { port: backendPort, authToken } = await spawnBackend();
    debugLog("[main] Backend started on port: " + backendPort);

    // Expose backend connection info so IPC handlers can return it to renderer
    process.env.OPENDEVS_BACKEND_PORT = String(backendPort);
    process.env.OPENDEVS_AUTH_TOKEN = authToken;
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

  // Sidecar is now spawned by the backend process (sidecar.service.ts)
  // when SIDECAR_BUNDLE_PATH env var is present.

  // Register IPC handlers before window creation so they're ready immediately
  registerNativeHandlers();
  registerBrowserViewHandlers();
  debugLog("[main] Creating window...");
  // PTY, FS watching, browser server — all handled by backend now

  await createWindow();
  debugLog("[main] Window created");

  // Auto-updater (delayed start — let the app boot first)
  if (!is.dev) {
    setTimeout(() => {
      if (mainWindow) setupAutoUpdater(mainWindow);
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
  destroyAllBrowserViews();
  stopBackend();
});

// Export for IPC handlers that need window reference
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
