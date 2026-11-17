/**
 * Web permissions: refused unless listed. Electron grants every request a page
 * makes unless the app says otherwise, and shows no prompt of its own, so a
 * page in a Browser tab could reach the camera, microphone, location or other
 * apps (`openExternal`) without asking anyone.
 */

import type { Session } from "electron";
import { originOf } from "./app-protocol";

/** What a page in a Browser tab may use, as a browser allows without a prompt. */
const GUEST = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/**
 * What the app's own window uses: its copy buttons (navigator.clipboard.writeText),
 * the notification when an agent finishes (platform/notifications), and the
 * clipboard the cloud device viewer is handed with `allow` (CloudSimulatorScreen),
 * for copy and paste into the device. A frame inside the window gets only what
 * the window hands it with `allow`: Chromium's Permissions Policy refuses the
 * rest before this is asked.
 */
const WINDOW = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications"]);

/** No `windowOrigin`: a Browser-tab page. Otherwise the window, when its page on top is the app's. */
export function allowsPermission(
  permission: string,
  topOrigin: string | null,
  windowOrigin?: string
): boolean {
  if (!windowOrigin) return GUEST.has(permission);
  return topOrigin === windowOrigin && WINDOW.has(permission);
}

/** Answer a session's permission checks and requests by `allowsPermission`; no `windowOrigin` for a guest session. */
export function limitPermissions(session: Session, windowOrigin?: string): void {
  session.setPermissionRequestHandler((contents, permission, callback) =>
    callback(allowsPermission(permission, originOf(contents.getURL()), windowOrigin))
  );
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    allowsPermission(
      permission,
      originOf(details.embeddingOrigin ?? requestingOrigin),
      windowOrigin
    )
  );
}
