/**
 * Main-process helpers for the <webview>-based browser path.
 *
 *   1. CDP viewport emulation (requires debugger attach — cannot be done
 *      from executeJavaScript, which runs in the guest page context).
 *   2. DevTools open/close. To render DevTools inline inside the browser
 *      panel we use Electron's `setDevToolsWebContents`: the renderer hosts
 *      a second <webview> and passes its webContents id, then we attach the
 *      page's DevTools UI into it. Without that custom host, guest DevTools
 *      always open as a separate window — docked modes don't work because a
 *      <webview> guest doesn't own a BrowserWindow to dock into.
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

      // Track what we did so a partial failure (attach OK but setDeviceMetrics
      // throws, or zoom set but setTouchEmulation throws) doesn't leave the
      // guest zoomed / attached with stale overrides. The next emulation call
      // would then start from a corrupted state.
      const attachedHere = !wc.debugger.isAttached();
      let metricsApplied = false;
      let zoomChanged = false;
      try {
        if (attachedHere) wc.debugger.attach("1.3");

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
        metricsApplied = true;
        wc.setZoomFactor(scale !== undefined && scale < 1 ? scale : 1);
        zoomChanged = true;

        await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled: mobile,
          ...(mobile ? { maxTouchPoints: 5 } : {}),
        });

        emulatedIds.add(webContentsId);
        return { success: true };
      } catch (err) {
        // Rollback: undo whatever partial work succeeded so the caller can
        // retry from a clean slate instead of layering state onto a half-done
        // emulation.
        try {
          if (metricsApplied && wc.debugger.isAttached()) {
            await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride", {});
            await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
              enabled: false,
            });
          }
          if (zoomChanged) wc.setZoomFactor(1);
          if (attachedHere && wc.debugger.isAttached()) wc.debugger.detach();
        } catch (rollbackErr) {
          console.error("[browser-emulation] rollback failed:", rollbackErr);
        }
        emulatedIds.delete(webContentsId);
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
        devtoolsWebContentsId,
        mode = "detach",
      }: {
        webContentsId: number;
        /** Optional. When present, DevTools render into that webContents
         *  instead of Electron's default window — used by the renderer to
         *  dock DevTools inside the browser panel via a second <webview>. */
        devtoolsWebContentsId?: number;
        mode?: "right" | "bottom" | "undocked" | "detach";
      }
    ): { success: boolean; error?: string } => {
      const wc = webContents.fromId(webContentsId);
      if (!wc || wc.isDestroyed()) return { success: false, error: "webContents not found" };
      try {
        if (devtoolsWebContentsId !== undefined) {
          const dt = webContents.fromId(devtoolsWebContentsId);
          if (!dt || dt.isDestroyed()) {
            return { success: false, error: "devtools webContents not found" };
          }
          // setDevToolsWebContents only takes effect when DevTools aren't
          // already attached to a different host — close any prior session
          // so reopening into the panel works after a detached-open attempt.
          if (wc.isDevToolsOpened()) wc.closeDevTools();
          wc.setDevToolsWebContents(dt);
          wc.openDevTools();
          return { success: true };
        }
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
