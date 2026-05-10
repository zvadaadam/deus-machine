/**
 * Auto-Updater
 *
 * Uses electron-updater to check for updates on GitHub Releases.
 * Sends update state to the renderer via webContents.send so the
 * frontend can show update toasts.
 */

import { type BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";

export type UpdateState =
  | { stage: "idle" }
  | { stage: "checking" }
  | { stage: "downloading"; progress: ProgressInfo }
  | { stage: "ready"; version?: string; releaseNotes?: string }
  | { stage: "error"; error: string };

type UpdateCheckResult =
  | { supported: false; available: false; reason: string }
  | { supported: true; available: false }
  | { supported: true; available: true; version?: string; releaseNotes?: string };

let currentState: UpdateState = { stage: "idle" };
let handlersRegistered = false;
let updaterStarted = false;

function isAutoUpdateSupported(): boolean {
  // electron-updater can update Linux AppImages; deb/rpm users update through
  // their package manager or by downloading a new installer.
  return !(process.platform === "linux" && !process.env.APPIMAGE);
}

function formatReleaseNotes(info: UpdateInfo): string | undefined {
  if (typeof info.releaseNotes === "string") return info.releaseNotes;
  if (Array.isArray(info.releaseNotes)) {
    return (
      info.releaseNotes
        .map((note) => note.note)
        .filter(Boolean)
        .join("\n\n") || undefined
    );
  }
  return undefined;
}

function toReadyState(info: UpdateInfo): UpdateState {
  return {
    stage: "ready",
    version: info.version,
    releaseNotes: formatReleaseNotes(info),
  };
}

function sendState(win: BrowserWindow, state: UpdateState): void {
  currentState = state;
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send("update:state", state);
}

export function registerUpdateHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle("update:check", async (): Promise<UpdateCheckResult> => {
    if (!isAutoUpdateSupported()) {
      currentState = { stage: "idle" };
      return {
        supported: false,
        available: false,
        reason: "Linux auto-update requires the AppImage build",
      };
    }

    currentState = { stage: "checking" };
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        currentState = { stage: "idle" };
        return { supported: true, available: false };
      }
      return {
        supported: true,
        available: true,
        version: result.updateInfo.version,
        releaseNotes: formatReleaseNotes(result.updateInfo),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      currentState = { stage: "error", error: message };
      console.error("[auto-updater] Check failed:", err);
      return { supported: true, available: false };
    }
  });

  ipcMain.handle("update:download", async () => {
    if (!isAutoUpdateSupported()) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      currentState = { stage: "error", error: message };
      console.error("[auto-updater] Download failed:", err);
    }
  });

  ipcMain.handle("update:install", () => {
    if (!isAutoUpdateSupported()) return;
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("update:getState", () => currentState);
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  registerUpdateHandlers();

  if (!isAutoUpdateSupported()) {
    console.log("[auto-updater] Skipping — Linux auto-update requires AppImage");
    return;
  }

  if (updaterStarted) return;
  updaterStarted = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    sendState(mainWindow, { stage: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    sendState(mainWindow, toReadyState(info));
  });

  autoUpdater.on("update-not-available", () => {
    sendState(mainWindow, { stage: "idle" });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendState(mainWindow, { stage: "downloading", progress });
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendState(mainWindow, toReadyState(info));
  });

  autoUpdater.on("error", (err) => {
    sendState(mainWindow, { stage: "error", error: err.message });
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[auto-updater] Initial check failed:", err);
  });

  // Periodic check every 4 hours (unref so timer doesn't block app quit)
  const timer = setInterval(
    () => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error("[auto-updater] Periodic check failed:", err);
      });
    },
    4 * 60 * 60 * 1000
  );
  timer.unref();
}
