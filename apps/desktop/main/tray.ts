/**
 * System Tray
 *
 * Adds a Deus icon to the macOS menu bar / Windows system tray.
 * Shows backend connectivity status with a colored indicator dot.
 *
 * Status:
 *  - Green dot + "Running"  → backend healthy
 *  - Red dot + "Offline"    → backend unreachable
 *  - Yellow dot + "Starting" → initial state before first health check
 */

import { Tray, Menu, nativeImage, app, BrowserWindow } from "electron";
import { join } from "path";

let tray: Tray | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;

type TrayStatus = "starting" | "running" | "offline";

/**
 * Create the system tray icon and start health polling.
 * Call after backend is spawned and the port is known.
 */
export function setupTray(backendPort: number): void {
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
  tray.setToolTip("Deus — Starting...");

  // Click tray icon → show/focus main window
  tray.on("click", showMainWindow);

  updateTrayMenu("starting");
  startHealthPolling(backendPort);
}

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
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
 * Poll the backend health endpoint every 10s. Update the tray
 * status dot based on whether the backend responds.
 */
function startHealthPolling(port: number): void {
  let lastStatus: TrayStatus = "starting";

  async function check(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const next: TrayStatus = res.ok ? "running" : "offline";
      if (next !== lastStatus) {
        lastStatus = next;
        updateTrayMenu(next);
      }
    } catch {
      if (lastStatus !== "offline") {
        lastStatus = "offline";
        updateTrayMenu("offline");
      }
    }
  }

  // First check after a short delay (give backend time to boot)
  setTimeout(check, 2000);
  healthInterval = setInterval(check, 10_000);
}

/**
 * Clean up tray and stop polling. Call on app quit.
 */
export function destroyTray(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
