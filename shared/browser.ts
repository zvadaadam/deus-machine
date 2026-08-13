/**
 * Shared browser constants.
 *
 * Single source of truth for the in-app browser's Electron session partition —
 * used by the renderer <webview> (webview-manager.ts) and by the main process
 * when injecting imported cookies (browser-cookies.ts). Keeping it here prevents
 * the two from silently drifting, which would land cookies in the wrong session.
 */

/** Persistent partition shared by every browser tab and the agent's CDP target. */
export const WEBVIEW_PARTITION = "persist:browser";
