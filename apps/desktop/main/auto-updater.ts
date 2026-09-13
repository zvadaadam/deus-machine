import { app, autoUpdater as nativeAutoUpdater, type BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { UpdateCheckResult, UpdateState } from "../../../shared/types/updates";

let currentState: UpdateState = { stage: "idle" };
let updateWindow: BrowserWindow | null = null;
let handlersRegistered = false;
let updaterStarted = false;
let installRequested = false;

function isAutoUpdateSupported(): boolean {
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

function sendState(state: UpdateState): void {
  currentState = state;
  if (!updateWindow || updateWindow.isDestroyed() || updateWindow.webContents.isDestroyed()) return;
  updateWindow.webContents.send("update:state", state);
}

function reportError(err: unknown): void {
  installRequested = false;
  sendState({ stage: "error", error: err instanceof Error ? err.message : String(err) });
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isAutoUpdateSupported()) {
    return {
      supported: false,
      available: false,
      reason: "Linux auto-update requires the AppImage build",
    };
  }
  // A renderer remount or manual check must not discard an in-flight/staged update.
  if (currentState.stage === "downloading" || currentState.stage === "ready") {
    return { supported: true, available: true };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    // electron-updater owns download deduplication. Observe the promise so a
    // background download failure cannot become an unhandled rejection.
    void result?.downloadPromise?.catch(reportError);
    if (!result) sendState({ stage: "idle" });
    return { supported: true, available: result?.isUpdateAvailable ?? false };
  } catch (err) {
    reportError(err);
    throw err;
  }
}

export function registerUpdateHandlers(quitAfterStopping: (quit: () => void) => void): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  if (process.platform === "linux" && process.env.APPIMAGE) {
    // AppImage normally starts the replacement before the old app quits.
    // Let Electron launch it after shutdown instead, using the installed name.
    autoUpdater.autoRunAppAfterInstall = false;
    let appImagePath = process.env.APPIMAGE;
    autoUpdater.on("appimage-filename-updated", (path: string) => {
      appImagePath = path;
    });
    nativeAutoUpdater.once("before-quit-for-update", () => {
      // The updater emits this only after installation succeeds. An install
      // error must leave the current backend running so the app stays usable.
      quitAfterStopping(() => {
        app.relaunch({ execPath: appImagePath });
        app.quit();
      });
    });
  }

  ipcMain.handle("update:check", checkForUpdates);
  ipcMain.handle("update:getState", () => currentState);
  ipcMain.handle("update:install", () => {
    if (!isAutoUpdateSupported() || currentState.stage !== "ready" || installRequested) return;
    installRequested = true;
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      reportError(err);
      throw err;
    }
  });
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  updateWindow = mainWindow;
  if (!isAutoUpdateSupported() || updaterStarted) return;
  updaterStarted = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => sendState({ stage: "checking" }));
  autoUpdater.on("update-not-available", () => sendState({ stage: "idle" }));
  autoUpdater.on("update-available", (info) => {
    sendState({ stage: "downloading", version: info.version });
  });
  autoUpdater.on("download-progress", (progress) => {
    if (currentState.stage === "downloading") {
      sendState({ ...currentState, percent: progress.percent });
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    sendState({ stage: "ready", version: info.version, releaseNotes: formatReleaseNotes(info) });
  });
  autoUpdater.on("error", reportError);

  const check = () => void checkForUpdates().catch((err) => console.error("[auto-updater]", err));
  check();
  const timer = setInterval(check, 4 * 60 * 60 * 1000);
  timer.unref();
}
