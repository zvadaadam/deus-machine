import { app, autoUpdater as nativeAutoUpdater, type BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { UpdateCheckResult, UpdateState } from "../../../shared/types/updates";

function initialState(): UpdateState {
  if (process.platform === "linux" && !process.env.APPIMAGE)
    return { stage: "unsupported", reason: "Linux auto-update requires the AppImage build." };
  if (!app.isPackaged)
    return { stage: "unsupported", reason: "Development builds do not download updates." };
  return { stage: "idle" };
}

let currentState = initialState();
let updateWindow: BrowserWindow | null = null;
let handlersRegistered = false;
let updaterStarted = false;
let installRequested = false;
let macArchive: UpdateInfo | undefined;

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
  // An archive that failed to stage or install can be installed by hand.
  const version =
    macArchive?.version ??
    (currentState.stage === "ready" || currentState.stage === "error"
      ? currentState.version
      : undefined);
  installRequested = false;
  macArchive = undefined;
  sendState({
    stage: "error",
    error: err instanceof Error ? err.message : String(err),
    ...(version && { version }),
  });
}

function reportReady(info: UpdateInfo): void {
  sendState({ stage: "ready", version: info.version, releaseNotes: formatReleaseNotes(info) });
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (currentState.stage === "unsupported") {
    return { supported: false, available: false, reason: currentState.reason };
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
    if (currentState.stage !== "ready" || installRequested) return;
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
  if (currentState.stage === "unsupported" || updaterStarted) return;
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
  if (process.platform === "darwin") {
    // electron-updater has the ZIP first. Only the native updater knows when
    // macOS has verified its signature and staged it for restart.
    autoUpdater.on("update-downloaded", (info) => {
      macArchive = info;
    });
    nativeAutoUpdater.on("update-downloaded", () => {
      if (macArchive) reportReady(macArchive);
      macArchive = undefined;
    });
  } else {
    autoUpdater.on("update-downloaded", reportReady);
  }
  autoUpdater.on("error", reportError);

  const check = () => void checkForUpdates().catch((err) => console.error("[auto-updater]", err));
  check();
  const timer = setInterval(check, 4 * 60 * 60 * 1000);
  timer.unref();
}
