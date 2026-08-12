/**
 * Main-process cookie injection for the in-app browser.
 *
 * The backend reads + decrypts cookies from the user's real Chromium profiles
 * (see browser-import.service.ts) and forwards them here. We write them into
 * the `persist:browser` session — the same partition the browser <webview>
 * uses (see apps/web/.../webview-manager.ts) and that agent-browser drives over
 * CDP — so both the visible browser and the agent become logged in.
 *
 * This is the one step that needs a native Electron API (`session.cookies`),
 * so it lives in main rather than the backend.
 */

import { ipcMain, session } from "electron";
import { WEBVIEW_PARTITION } from "../../../shared/browser";
import type { ImportCookie, ImportCookiesResult } from "../../../shared/types/browser-import";

export function registerBrowserCookieHandlers(): void {
  ipcMain.handle(
    "browser_import_cookies",
    async (_e, { cookies }: { cookies: ImportCookie[] }): Promise<ImportCookiesResult> => {
      if (!Array.isArray(cookies)) {
        return { success: false, imported: 0, failed: 0, error: "cookies must be an array" };
      }

      const ses = session.fromPartition(WEBVIEW_PARTITION);
      let imported = 0;
      let failed = 0;

      for (const c of cookies) {
        try {
          await ses.cookies.set({
            url: c.url,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
            sameSite: c.sameSite,
          });
          imported += 1;
        } catch {
          // A single malformed cookie shouldn't abort the whole import — Chrome
          // stores edge cases (e.g. __Host- prefixes with a domain) that
          // Electron rejects. Skip and keep going, like the source app does.
          failed += 1;
        }
      }

      return { success: true, imported, failed };
    }
  );
}
