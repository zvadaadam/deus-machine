/**
 * Web permissions: refused unless listed. Electron grants every request a page
 * makes unless the app says otherwise, and shows no prompt of its own, so a
 * page in a Browser tab could reach the camera, microphone, location or other
 * apps (`openExternal`) without asking anyone.
 */

import type { Session, WebContents } from "electron";
import { originOf } from "./app-protocol";

/** What a page in a Browser tab may use, as a browser allows without a prompt. */
const GUEST = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/**
 * What the app's own window uses: its copy buttons (navigator.clipboard.writeText)
 * and the notification when an agent finishes (platform/notifications).
 */
const WINDOW = new Set(["clipboard-sanitized-write", "notifications"]);

export function allowsPermission(
  permission: string,
  from: { guest: boolean; origin: string | null; windowOrigin: string }
): boolean {
  if (from.guest) return GUEST.has(permission);
  return from.origin === from.windowOrigin && WINDOW.has(permission);
}

/** Answer a session's permission checks and requests by `allowsPermission`. */
export function limitPermissions(session: Session, windowOrigin: string): void {
  const allows = (contents: WebContents | null, permission: string, url: string | undefined) =>
    allowsPermission(permission, {
      // The window's own page, or a frame inside it; anything else (a <webview>) is a guest.
      guest: contents?.getType() !== "window",
      origin: url ? originOf(url) : null,
      windowOrigin,
    });
  session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allows(contents, permission, details.requestingUrl))
  );
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    allows(contents, permission, requestingOrigin)
  );
}
