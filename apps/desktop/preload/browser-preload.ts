/**
 * Guest-page preload — attached to every <webview> via `will-attach-webview`.
 *
 * Responsibilities are intentionally narrow; the host <webview> DOM events
 * (`console-message`, `did-navigate`, `page-title-updated`, `did-fail-load`,
 * `did-start-loading`, …) already give the renderer everything it needs, so
 * we do NOT mirror those over IPC. What remains is keyboard-shortcut
 * routing: Cmd+R inside the guest should reload the tab, Cmd+L should focus
 * the URL bar in our shell, and Cmd+Shift+D should toggle the shell's inspect
 * mode. Sent via `ipcRenderer.sendToHost(...)`, which delivers to the host
 * webContents as an `ipc-message` DOM event on the <webview> element.
 */

import { ipcRenderer } from "electron";

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
