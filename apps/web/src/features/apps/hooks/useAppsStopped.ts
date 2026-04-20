/**
 * Listen for `apps:stopped` q:event broadcasts and close Browser tabs that
 * still point at the (now-dead) app URL.
 *
 * The backend emits this event from `apps.service.handleChildExit`, covering
 * all exit paths — user-initiated stopApp, agent-initiated stop_app tool,
 * workspace-archive sweeps, crashes. The UX is identical in every case: the
 * port is gone, so any open tab pointing at it is stale. Refresh would just
 * error. We close proactively.
 *
 * Prefix matching (via BrowserPanel) catches the case where the user
 * navigated within the app's SPA — the origin is still dead even if the
 * path changed.
 *
 * Symmetric with useAppsLaunched: same workspace-scoping, same unknown-
 * payload narrowing. Keep the two hooks side-by-side so lifecycle handling
 * stays in one place.
 */

import { useEffect } from "react";
import { onEvent } from "@/platform/ws/query-protocol-client";
import type { AppsStoppedEvent } from "@shared/aap/types";
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";

export function useAppsStopped(currentWorkspaceId: string | null): void {
  useEffect(() => {
    if (!currentWorkspaceId) return;

    const unsubscribe = onEvent((event, data) => {
      if (event !== "apps:stopped") return;

      const payload = data as AppsStoppedEvent | null | undefined;
      if (!payload || typeof payload !== "object") return;
      if (payload.workspaceId !== currentWorkspaceId) return;
      if (typeof payload.url !== "string" || payload.url.length === 0) return;

      // Normalize to origin-only prefix (scheme+host+port, no trailing slash,
      // no path). Electron's BrowserView drops the root-path trailing slash
      // after load, so a tab opened at `http://127.0.0.1:49187/` ends up with
      // currentUrl = `http://127.0.0.1:49187` — a raw `startsWith` against the
      // manifest-provided url (which keeps the slash) would miss it. Comparing
      // at the origin also catches SPA navigation within the app (the port
      // is dead either way).
      const origin = (() => {
        try {
          return new URL(payload.url).origin;
        } catch {
          return payload.url.replace(/\/+$/, "");
        }
      })();
      browserWindowActions.requestCloseTabByUrlPrefix(currentWorkspaceId, origin);
    });

    return unsubscribe;
  }, [currentWorkspaceId]);
}
