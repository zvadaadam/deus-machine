import { app, type BrowserWindow } from "electron";

export function focusWindow(window: BrowserWindow): void {
  // Restoring a minimized window may leave another Mac app frontmost.
  if (process.platform === "darwin") app.focus({ steal: true });
  if (window.isMinimized()) window.restore();
  else if (!window.isVisible()) return; // The renderer owns the first show.
  window.focus();
}
