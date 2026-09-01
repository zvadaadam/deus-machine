/**
 * Web-direct mode — the "deusmachine.ai IS the product" deployment signal.
 *
 * One production web build serves TWO audiences from the root domain:
 *   - web-direct: the default. The browser drives cloud agents against agnt
 *     with no Mac backend (WorkOS login, dashboard REST, direct session
 *     sockets). Product routes live at the root: `/`, `/w/:id`, `/settings`.
 *   - relay: the Mac-remote-control flows, reachable ONLY through their own
 *     URLs (`/connect*`, `/s/:serverId/*`) — pairing links keep working.
 *
 * So the mode is entry-path-scoped: the build flag turns web-direct on, and a
 * relay entry path vetoes it for that visit. The veto applies only to real web
 * builds — in `web-dev` (localhost with VITE_BACKEND_PORT) the app lives under
 * the synthetic `/s/local` path, where the localStorage override must still be
 * able to force web-direct behavior for testing.
 *
 * This lives in shared/config (not the cloud feature) because the deployment
 * mode enum in `backend.config.ts` derives from it — feature code re-exports
 * from here, never the other way around.
 */

import { capabilities } from "@/platform/capabilities";

/** Relay-owned entry paths: pairing + server-scoped sessions. */
export function isRelayEntryPath(pathname: string): boolean {
  return pathname === "/connect" || pathname.startsWith("/connect/") || pathname.startsWith("/s/");
}

/**
 * Whether this visit runs fully Mac-closed (mint tokens from the browser's own
 * WorkOS session; serve reads from agnt; keep the q: transport dark).
 * The `deus.cloudDirectWeb` localStorage override forces it on/off on any
 * build; the production signal is the build-time env `VITE_CLOUD_DIRECT`.
 */
export function isCloudDirectWebMode(): boolean {
  // Electron always has its own backend — web-direct (env flag OR override)
  // must never hijack the desktop's data path.
  if (capabilities.ipcInvoke) return false;
  try {
    // A relay entry keeps its existing behavior even on a web-direct build —
    // except in web-dev, where /s/local is the app's own synthetic path.
    if (
      !import.meta.env.VITE_BACKEND_PORT &&
      typeof window !== "undefined" &&
      isRelayEntryPath(window.location?.pathname ?? "")
    ) {
      return false;
    }
  } catch {
    /* no window (tests) — fall through to the flags */
  }
  try {
    const override = localStorage.getItem("deus.cloudDirectWeb");
    if (override === "1") return true;
    if (override === "0") return false;
  } catch {
    /* localStorage unavailable — fall through to the build flag */
  }
  const flag = import.meta.env.VITE_CLOUD_DIRECT;
  return flag === "1" || flag === "true";
}
