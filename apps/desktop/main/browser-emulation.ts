/**
 * Main-process helpers for the <webview>-based browser path.
 *
 * Two things need to reach the compositor side (outside the renderer):
 *   1. CDP viewport emulation (requires debugger attach — cannot be done
 *      from executeJavaScript, which runs in the guest page context).
 *   2. DevTools with a specific dock mode. `<webview>.openDevTools()` on the
 *      renderer element has no `mode` parameter and always opens detached;
 *      going through `webContents.openDevTools({ mode: "bottom" })` on the
 *      main side is the only way to dock.
 *
 * Both identify the target by `webContentsId`, which the renderer gets from
 * `webview.getWebContentsId()` after the guest page attaches.
 */

import { ipcMain, webContents } from "electron";

const emulatedIds = new Set<number>();

export function registerBrowserEmulationHandlers(): void {
  ipcMain.handle(
    "browser_webview_emulation_set",
    async (
      _e,
      {
        webContentsId,
        width,
        height,
        deviceScaleFactor,
        mobile,
        scale,
      }: {
        webContentsId: number;
        width: number;
        height: number;
        deviceScaleFactor: number;
        mobile: boolean;
        scale?: number;
      }
    ): Promise<{ success: boolean; error?: string }> => {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) return { success: false, error: "webContents not found" };

      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");

        // Always apply device-metrics override so the page reflows for the
        // emulated device (mobile UA + breakpoints kick in from the `mobile`
        // flag + width). Separately, a sub-unity `scale` shrinks the rendered
        // output so oversized viewports (Desktop 1920×1080 on a narrow panel)
        // still fit — that's exactly what webContents.setZoomFactor does.
        await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor,
          mobile,
        });
        wc.setZoomFactor(scale !== undefined && scale < 1 ? scale : 1);

        await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled: mobile,
          ...(mobile ? { maxTouchPoints: 5 } : {}),
        });

        emulatedIds.add(webContentsId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "browser_webview_emulation_clear",
    async (
      _e,
      { webContentsId }: { webContentsId: number }
    ): Promise<{ success: boolean; error?: string }> => {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) return { success: false, error: "webContents not found" };

      try {
        if (wc.debugger.isAttached()) {
          await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride", {});
          await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
          // Detach the debugger so Chromium fully releases emulation state and
          // re-runs layout against the webview element's real dimensions. Just
          // calling clearDeviceMetricsOverride leaves an active CDP session
          // that can retain stale viewport state — the page stays laid-out at
          // the previous mobile dims until something else (navigation, zoom
          // change) invalidates layout. Detaching is the cleanest signal.
          // Next setEmulation call re-attaches (it checks isAttached()).
          wc.debugger.detach();
        }
        wc.setZoomFactor(1);
        emulatedIds.delete(webContentsId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "browser_webview_devtools_open",
    (
      _e,
      {
        webContentsId,
        mode = "bottom",
      }: { webContentsId: number; mode?: "right" | "bottom" | "undocked" | "detach" }
    ): { success: boolean; error?: string } => {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) return { success: false, error: "webContents not found" };
      try {
        wc.openDevTools({ mode });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "browser_webview_devtools_close",
    (_e, { webContentsId }: { webContentsId: number }): { success: boolean; error?: string } => {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) return { success: false, error: "webContents not found" };
      try {
        wc.closeDevTools();
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );
}
