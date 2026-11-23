/**
 * System Tray
 *
 * Adds a Deus icon to the macOS menu bar / Windows system tray.
 * Shows backend connectivity status with a colored indicator dot.
 *
 * Status follows the backend process (backend-process.ts tells index.ts):
 *  - Green dot + "Running"  → a backend has started (the first or a restart)
 *  - Red dot + "Offline"    → the backend exited and no other has started yet
 *  - Yellow dot + "Starting" → before the first backend has started
 */

import { Tray, Menu, nativeImage, app, BrowserWindow } from "electron";
import { join } from "path";
import { focusWindow } from "./focus-window";

type TrayStatus = "starting" | "running" | "offline";

let tray: Tray | null = null;
let status: TrayStatus = "starting";

/** Record the backend's state; shown at once if the tray exists, else when it is made. */
export function setTrayStatus(next: TrayStatus): void {
  if (next === status) return;
  status = next;
  updateTrayMenu(next);
}

/** Create the system tray icon, showing the backend's current status. */
export function setupTray(): void {
  // Monochrome alpha glyph — macOS tints template images for light/dark
  // menu bars; on Windows it shows white-on-tray. The full app icon
  // (icon.png) is colored RGBA and isn't suitable as a template.
  const iconPath = join(__dirname, "../../resources/icons/icon-tray.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });

  // Mark as template so macOS renders it correctly in the menu bar
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);

  // Click tray icon → show/focus main window
  tray.on("click", showMainWindow);

  updateTrayMenu(status);
}

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) focusWindow(win);
}

function updateTrayMenu(status: TrayStatus): void {
  if (!tray) return;

  const statusLabel =
    status === "running"
      ? "🟢  Backend running"
      : status === "offline"
        ? "🔴  Backend offline"
        : "🟡  Backend starting...";

  const tooltip =
    status === "running"
      ? "Deus — Running"
      : status === "offline"
        ? "Deus — Offline"
        : "Deus — Starting...";

  tray.setToolTip(tooltip);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Deus", enabled: false },
    { type: "separator" },
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "Show Window", click: showMainWindow },
    { type: "separator" },
    { label: "Quit Deus", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * Clean up tray. Call on app quit.
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
