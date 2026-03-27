/**
 * Native IPC Handlers
 *
 * Registers ipcMain.handle() for native OS operations that the renderer
 * accesses through the preload bridge.
 *
 * Handler names use the SAME names the renderer calls via invoke().
 * The preload's generic invoke() forwards channel names unchanged, so
 * snake_case names here must match the renderer exactly.
 */

import { ipcMain, dialog, nativeTheme, BrowserWindow, shell, Menu, app } from "electron";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

export function registerNativeHandlers(): void {
  // -------------------------------------------------------------------------
  // Window visibility
  // -------------------------------------------------------------------------

  ipcMain.handle("show_main_window", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      // Transition to app mode — vibrancy + solid background.
      if (process.platform === "darwin") {
        win.setVibrancy("under-window");
      }
      win.setBackgroundColor("#1a1a1a");
      win.show();
      win.focus();
    }
  });

  ipcMain.handle("enter_onboarding_mode", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setBackgroundColor("#0e0e10");
      if (process.platform === "darwin") {
        win.setWindowButtonVisibility(false);
      }
      win.show();
    }
  });

  ipcMain.handle("exit_onboarding_mode", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (process.platform === "darwin") {
        win.setWindowButtonVisibility(true);
        win.setVibrancy("under-window");
      }
      win.setBackgroundColor("#1a1a1a");
    }
  });

  // -------------------------------------------------------------------------
  // Folder picker
  // -------------------------------------------------------------------------

  ipcMain.handle("show_folder_dialog", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Keep the native: prefixed name too — the preload's named methods
  // (pickFolder, confirm, etc.) call "native:pickFolder" directly.
  ipcMain.handle("native:pickFolder", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // -------------------------------------------------------------------------
  // Confirm dialog
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "native:confirm",
    async (_e, { message, detail }: { message: string; detail?: string }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return false;
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Cancel", "Confirm"],
        defaultId: 1,
        message,
        detail,
      });
      return response === 1;
    }
  );

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  ipcMain.handle("native:setTheme", (_e, { theme }: { theme: "light" | "dark" | "system" }) => {
    nativeTheme.themeSource = theme;
  });

  // -------------------------------------------------------------------------
  // Open external URL
  // -------------------------------------------------------------------------

  ipcMain.handle("native:openExternal", (_e, { url }: { url: string }) => {
    // Security: only allow http/https URLs to prevent shell command injection
    // via custom protocol handlers (e.g., file://, javascript:, vbscript:).
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        shell.openExternal(url);
      }
    } catch {
      // Ignore malformed URLs
    }
  });

  // -------------------------------------------------------------------------
  // Context menu
  // -------------------------------------------------------------------------

  ipcMain.handle(
    "native:contextMenu",
    (
      _e,
      { items }: { items: Array<{ id: string; label: string; type?: string; enabled?: boolean }> }
    ) => {
      return new Promise<string | null>((resolve) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win) {
          resolve(null);
          return;
        }
        const menu = Menu.buildFromTemplate(
          items.map((item) => ({
            label: item.label,
            click: () => resolve(item.id),
            type: item.type as "normal" | "separator" | undefined,
            enabled: item.enabled ?? true,
          }))
        );
        menu.popup({ window: win, callback: () => resolve(null) });
      });
    }
  );

  // -------------------------------------------------------------------------
  // Backend connection info (renderer needs this to connect WebSocket)
  // Registered under BOTH names:
  //   - "native:getBackendPort" — preload named method calls this directly
  //   - "get_backend_port"      — generic invoke() from renderer code
  // -------------------------------------------------------------------------

  ipcMain.handle("native:getBackendPort", () => {
    return parseInt(process.env.DEUS_BACKEND_PORT!, 10);
  });

  ipcMain.handle("get_backend_port", () => {
    return parseInt(process.env.DEUS_BACKEND_PORT!, 10);
  });

  ipcMain.handle("native:getAuthToken", () => {
    return process.env.DEUS_AUTH_TOKEN;
  });

  // -------------------------------------------------------------------------
  // Window controls — keep native: prefix since preload methods call these
  // -------------------------------------------------------------------------

  ipcMain.handle("native:minimize", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.minimize();
  });

  ipcMain.handle("native:maximize", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle("native:close", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.close();
  });

  ipcMain.handle("native:isMaximized", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return win?.isMaximized() ?? false;
  });

  ipcMain.handle("native:isFullscreen", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return win?.isFullScreen() ?? false;
  });

  ipcMain.handle("native:toggleFullscreen", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  // -------------------------------------------------------------------------
  // CLI tool checks
  // -------------------------------------------------------------------------

  ipcMain.handle("native:checkCliTool", async (_e, args: { name?: string; tool?: string }) => {
    const tool = args.name || args.tool || "";
    try {
      const { stdout } = await execFileAsync("which", [tool]);
      return { installed: true, path: stdout.trim() };
    } catch {
      return { installed: false, path: null };
    }
  });

  ipcMain.handle("check_cli_tool", async (_e, args: { name?: string; tool?: string }) => {
    const tool = args.name || args.tool || "";
    try {
      const { stdout } = await execFileAsync("which", [tool]);
      return { installed: true, path: stdout.trim() };
    } catch {
      return { installed: false, path: null };
    }
  });

  ipcMain.handle("native:checkGhAuth", async () => {
    try {
      await execFileAsync("gh", ["auth", "status"]);
      return { authenticated: true };
    } catch {
      return { authenticated: false };
    }
  });

  ipcMain.handle("check_gh_auth", async () => {
    try {
      await execFileAsync("gh", ["auth", "status"]);
      return { authenticated: true };
    } catch {
      return { authenticated: false };
    }
  });

  // -------------------------------------------------------------------------
  // App detection
  // -------------------------------------------------------------------------

  ipcMain.handle("native:getInstalledApps", async () => {
    return getInstalledAppsList();
  });

  ipcMain.handle("get_installed_apps", async () => {
    return getInstalledAppsList();
  });

  // Renderer calls invoke("open_in_app", { appId, workspacePath })
  // We accept both the old native: shape AND the new snake_case shape.
  ipcMain.handle(
    "native:openInApp",
    async (_e, { appPath, filePath }: { appPath: string; filePath: string }) => {
      try {
        await execFileAsync("open", ["-a", appPath, filePath]);
        return true;
      } catch {
        return false;
      }
    }
  );

  ipcMain.handle(
    "open_in_app",
    async (_e, { appId, workspacePath }: { appId: string; workspacePath: string }) => {
      try {
        // Look up the app path from the cached installed apps list.
        // appId is our internal identifier (e.g., "cursor", "vscode"), not the macOS app name.
        const apps = await getInstalledAppsList();
        const app_ = apps.find((a) => a.id === appId);
        if (!app_) {
          console.warn(`[open_in_app] App not found: ${appId}`);
          return false;
        }
        await execFileAsync("open", ["-a", app_.path, workspacePath]);
        return true;
      } catch {
        return false;
      }
    }
  );

  // -------------------------------------------------------------------------
  // App info
  // -------------------------------------------------------------------------

  ipcMain.handle("native:getAppVersion", () => {
    return app.getVersion();
  });

  ipcMain.handle("native:getPlatform", () => {
    return process.platform;
  });

  // -------------------------------------------------------------------------
  // Zoom control — renderer calls invoke("native:setZoom", { level })
  // -------------------------------------------------------------------------

  ipcMain.handle("native:setZoom", (_e, { level }: { level: number }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.setZoomFactor(level);
    }
  });

  // -------------------------------------------------------------------------
  // Window title — renderer calls invoke("native:setTitle", { title })
  // Used by DetachedBrowserWindow to sync window title
  // -------------------------------------------------------------------------

  ipcMain.handle("native:setTitle", (_e, { title }: { title: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setTitle(title);
    }
  });

  // -------------------------------------------------------------------------
  // Home directory — renderer calls invoke("native:homeDir")
  // Used by CloneRepositoryModal and useRepoActions for default clone path
  // -------------------------------------------------------------------------

  ipcMain.handle("native:homeDir", () => {
    return homedir();
  });

  // Git clone is now handled by the backend via POST /api/repos/clone
}

// ---- Helpers ----

/** Curated list of apps we support in the "Open In" dropdown.
 * id = internal identifier (used by appIcons.tsx for categorization)
 * name = display name
 * bundleId = macOS bundle identifier for mdfind lookup */
const SUPPORTED_APPS = [
  // Editors
  { id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92" },
  { id: "vscode", name: "VS Code", bundleId: "com.microsoft.VSCode" },
  { id: "vscode-insiders", name: "VS Code Insiders", bundleId: "com.microsoft.VSCodeInsiders" },
  { id: "windsurf", name: "Windsurf", bundleId: "com.exafunction.windsurf" },
  { id: "zed", name: "Zed", bundleId: "dev.zed.Zed" },
  { id: "xcode", name: "Xcode", bundleId: "com.apple.dt.Xcode" },
  { id: "fleet", name: "Fleet", bundleId: "com.jetbrains.fleet" },
  { id: "intellij", name: "IntelliJ IDEA", bundleId: "com.jetbrains.intellij" },
  { id: "webstorm", name: "WebStorm", bundleId: "com.jetbrains.WebStorm" },
  { id: "sublime", name: "Sublime Text", bundleId: "com.sublimetext.4" },
  // Terminals
  { id: "terminal", name: "Terminal", bundleId: "com.apple.Terminal" },
  { id: "iterm", name: "iTerm", bundleId: "com.googlecode.iterm2" },
  { id: "warp", name: "Warp", bundleId: "dev.warp.Warp-Stable" },
  // System
  { id: "finder", name: "Finder", bundleId: "com.apple.finder" },
];

interface InstalledApp {
  id: string;
  name: string;
  path: string;
  icon?: string;
}

let cachedInstalledApps: InstalledApp[] | null = null;
let inflightPromise: Promise<InstalledApp[]> | null = null;

async function getInstalledAppsList(): Promise<InstalledApp[]> {
  if (cachedInstalledApps) return cachedInstalledApps;
  if (inflightPromise) return inflightPromise;
  if (process.platform !== "darwin") return [];
  inflightPromise = loadInstalledApps().finally(() => {
    inflightPromise = null;
  });
  return inflightPromise;
}

/** Resolve icon filename from an app's Info.plist (apps use different names). */
async function resolveIconFileName(appPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIconFile",
      `${appPath}/Contents/Info.plist`,
    ]);
    const name = stdout.trim();
    if (name) return name.endsWith(".icns") ? name : `${name}.icns`;
  } catch {
    // PlistBuddy failed
  }
  return "AppIcon.icns";
}

/** Extract app icon as a base64 PNG data URL. */
async function extractAppIcon(appPath: string, appId: string): Promise<string | undefined> {
  try {
    const iconFileName = await resolveIconFileName(appPath);
    const icnsPath = `${appPath}/Contents/Resources/${iconFileName}`;
    const tmpPng = `/tmp/deus-icon-${appId}.png`;
    await execFileAsync("sips", [
      "-s",
      "format",
      "png",
      "-z",
      "64",
      "64",
      icnsPath,
      "--out",
      tmpPng,
    ]);
    const fs = await import("fs/promises");
    const buf = await fs.readFile(tmpPng);
    await fs.unlink(tmpPng).catch(() => {});
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function loadInstalledApps(): Promise<InstalledApp[]> {
  const installed: InstalledApp[] = [];

  for (const appDef of SUPPORTED_APPS) {
    try {
      const { stdout } = await execFileAsync("mdfind", [
        `kMDItemCFBundleIdentifier == '${appDef.bundleId}'`,
      ]);
      const appPath = stdout.trim().split("\n")[0];
      if (!appPath || !appPath.endsWith(".app")) continue;

      const icon = await extractAppIcon(appPath, appDef.id);
      installed.push({ id: appDef.id, name: appDef.name, path: appPath, icon });
    } catch {
      // App not installed — skip
    }
  }

  cachedInstalledApps = installed;
  return installed;
}
