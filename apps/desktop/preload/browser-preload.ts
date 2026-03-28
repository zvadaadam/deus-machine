/**
 * Browser View Preload Script
 *
 * Injected into BrowserView content pages (the agent browser).
 *
 * Responsibilities:
 * 1. Console capture — forward to main process for the console panel
 * 2. Dialog override — alert/confirm/prompt are non-blocking (prevents app freeze)
 * 3. Keyboard shortcut routing — Cmd+R/L route back to IDE
 *
 * NOTE: WebAuthn and local-network-access polyfills are injected from the main
 * process via view.webContents.executeJavaScript() on `dom-ready`, which targets
 * the page's main world. The preload's webFrame.executeJavaScript() runs in the
 * isolated world and cannot override page-visible APIs.
 */

import { ipcRenderer } from "electron";

// ---------------------------------------------------------------------------
// Console capture — forward to main process
// ---------------------------------------------------------------------------

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

function forwardConsole(level: string, args: unknown[]): void {
  try {
    const serialized = args.map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    });
    ipcRenderer.send("browser:console-message", { level, args: serialized });
  } catch {
    // Swallow errors — never break page JS
  }
}

console.log = (...args: unknown[]) => {
  originalConsole.log(...args);
  forwardConsole("log", args);
};

console.warn = (...args: unknown[]) => {
  originalConsole.warn(...args);
  forwardConsole("warn", args);
};

console.error = (...args: unknown[]) => {
  originalConsole.error(...args);
  forwardConsole("error", args);
};

console.info = (...args: unknown[]) => {
  originalConsole.info(...args);
  forwardConsole("info", args);
};

// ---------------------------------------------------------------------------
// Override blocking dialogs to be non-blocking
// (intentional for agent automation — prevents app freeze from page dialogs)
// ---------------------------------------------------------------------------

window.alert = (message?: string) => {
  originalConsole.log("[alert]", message);
};

window.confirm = (_message?: string) => {
  originalConsole.log("[confirm]", _message);
  return true; // Always confirm
};

window.prompt = (_message?: string, _defaultValue?: string) => {
  originalConsole.log("[prompt]", _message);
  return _defaultValue ?? null;
};

// ---------------------------------------------------------------------------
// Keyboard shortcut routing
//
// When the BrowserView is focused, browser shortcuts (Cmd+R, Cmd+L, etc.)
// would be consumed by the webview. Route them to the IDE instead so the
// user gets expected behavior regardless of focus state.
// ---------------------------------------------------------------------------

window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;

    switch (e.key) {
      case "r":
        // Cmd+R → reload the BrowserView (not the IDE)
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send("browser:keyboard-shortcut", { shortcut: "reload" });
        break;
      case "l":
        // Cmd+L → focus the URL bar in our IDE
        e.preventDefault();
        e.stopPropagation();
        ipcRenderer.send("browser:keyboard-shortcut", { shortcut: "focus-url-bar" });
        break;
    }
  },
  true // capture phase — intercept before page handlers
);
