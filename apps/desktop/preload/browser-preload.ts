/**
 * Guest-page preload — attached to every <webview> via `will-attach-webview`.
 *
 * Responsibilities are intentionally narrow; the host <webview> DOM events
 * (`console-message`, `did-navigate`, `page-title-updated`, `did-fail-load`,
 * `did-start-loading`, …) already give the renderer everything it needs, so
 * we do NOT mirror those over IPC. What remains:
 *
 *   1. Non-blocking dialog overrides — a page calling alert()/confirm()/prompt()
 *      would otherwise freeze the guest thread.
 *   2. Keyboard-shortcut routing — Cmd+R inside the guest should reload the
 *      tab, Cmd+L should focus the URL bar in our shell, and Cmd+Shift+D
 *      should toggle the shell's inspect mode. Sent via
 *      `ipcRenderer.sendToHost(...)`, which delivers to the host webContents
 *      as an `ipc-message` DOM event on the <webview> element.
 */

import { ipcRenderer } from "electron";

// -----------------------------------------------------------------------------
// Override blocking dialogs — never freeze the app from guest JS.
// -----------------------------------------------------------------------------

// Fail-safe: every override denies. Auto-confirming (true) or echoing
// defaultValue could let a guest page auto-approve destructive actions
// (e.g. "Delete this file?") or submit forms with values the user never
// typed. Return the safest no-op for each API.
window.alert = (message?: string) => {
  console.log("[alert]", message);
};

window.confirm = (message?: string) => {
  console.log("[confirm]", message);
  return false;
};

window.prompt = (message?: string, _defaultValue?: string) => {
  console.log("[prompt]", message);
  return null;
};

// -----------------------------------------------------------------------------
// Keyboard shortcut routing — Cmd/Ctrl+R reload, Cmd/Ctrl+L focus URL bar,
// Cmd/Ctrl+Shift+D toggles inspect mode.
// Forwarded to the HOST webContents via sendToHost (no main process hop).
// -----------------------------------------------------------------------------

export type BrowserGuestShortcut = "reload" | "focus-url-bar" | "toggle-inspect-mode";

window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.repeat) return;
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    let shortcut: BrowserGuestShortcut | null = null;
    const key = e.key.toLowerCase();
    if (e.shiftKey && key === "d") shortcut = "toggle-inspect-mode";
    else if (key === "r") shortcut = "reload";
    else if (key === "l") shortcut = "focus-url-bar";
    if (!shortcut) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost("shortcut", shortcut);
  },
  true // capture — intercept before page handlers
);
