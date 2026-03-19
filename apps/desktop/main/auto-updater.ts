/**
 * Auto-Updater
 *
 * Uses electron-updater to check for updates on GitHub Releases.
 * Sends update state to the renderer via webContents.send so the
 * frontend can show update toasts.
 */

import { type BrowserWindow } from "electron";
import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; info: UpdateInfo }
  | { status: "not-available" }
  | { status: "downloading"; progress: ProgressInfo }
  | { status: "downloaded"; info: UpdateInfo }
  | { status: "error"; error: string };

let currentState: UpdateState = { status: "idle" };

function sendState(win: BrowserWindow, state: UpdateState): void {
  currentState = state;
  win.webContents.send("update:state", state);
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    sendState(mainWindow, { status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    sendState(mainWindow, { status: "available", info });
  });

  autoUpdater.on("update-not-available", () => {
    sendState(mainWindow, { status: "not-available" });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendState(mainWindow, { status: "downloading", progress });
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendState(mainWindow, { status: "downloaded", info });
  });

  autoUpdater.on("error", (err) => {
    sendState(mainWindow, { status: "error", error: err.message });
  });

  // IPC handlers for renderer to control updates
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require("electron");

  ipcMain.handle("update:check", async () => {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error("[auto-updater] Check failed:", err);
      return null;
    }
  });

  ipcMain.handle("update:download", async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      console.error("[auto-updater] Download failed:", err);
    }
  });

  ipcMain.handle("update:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("update:getState", () => {
    return currentState;
  });

  // Initial check after 15s delay (called from main/index.ts)
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[auto-updater] Initial check failed:", err);
  });

  // Periodic check every 4 hours
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error("[auto-updater] Periodic check failed:", err);
      });
    },
    4 * 60 * 60 * 1000
  );
}
