/**
 * Web permissions: refused unless listed. Electron grants every request a page
 * makes unless the app says otherwise, and shows no prompt of its own, so a
 * page in a Browser tab could reach the camera, microphone, location or other
 * apps (`openExternal`) without asking anyone.
 */

import type { Session } from "electron";
import { originOf } from "./app-protocol";

/** A page in a Browser tab, any origin: what a browser allows without a prompt. */
const GUEST = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/** The window's own page: its copy buttons and the notification when an agent finishes. */
const WINDOW = new Set(["clipboard-sanitized-write", "notifications"]);

/**
 * A frame of another origin inside the window's page: the clipboard, which
 * Chromium asks us about only when the page handed it over with `allow` (today
 * the cloud device viewer, CloudSimulatorScreen). Notifications cannot be
 * handed over, so a frame never gets them.
 */
const FRAME = new Set(["clipboard-read", "clipboard-sanitized-write"]);

/** No `windowOrigin`: a Browser-tab session. Otherwise the window's, when its page on top is the app's. */
export function allowsPermission(
  permission: string,
  from: { requesting: string | null; top: string | null },
  windowOrigin?: string
): boolean {
  if (windowOrigin === undefined) return GUEST.has(permission);
  if (from.top !== windowOrigin) return false;
  return (from.requesting === windowOrigin ? WINDOW : FRAME).has(permission);
}

/** Answer a session's permission checks and requests by `allowsPermission`; no `windowOrigin` for a guest session. */
export function limitPermissions(session: Session, windowOrigin?: string): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const from = { requesting: originOf(details.requestingUrl), top: originOf(contents.getURL()) };
    callback(allowsPermission(permission, from, windowOrigin));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const from = {
      requesting: originOf(requestingOrigin),
      top: originOf(details.embeddingOrigin ?? requestingOrigin),
    };
    return allowsPermission(permission, from, windowOrigin);
  });
}
