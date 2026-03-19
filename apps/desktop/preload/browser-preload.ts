/**
 * Browser View Preload Script
 *
 * Minimal preload injected into BrowserView content pages (the agent browser).
 * Captures console.log/warn/error and forwards to the main process for
 * the console panel in the IDE.
 *
 * Also overrides alert/confirm/prompt to be non-blocking (web pages showing
 * modal dialogs would freeze the entire Electron app).
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
