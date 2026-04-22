/**
 * Preload Script — Main Window
 *
 * Exposes a typed API to the renderer via contextBridge.
 * This is the ONLY way the renderer communicates with the main process.
 *
 * Security: contextIsolation=true, nodeIntegration=false, sandbox=false (ESM preload requires sandbox=false).
 * The renderer has zero direct access to Node.js or Electron APIs.
 *
 * The generic invoke/on/send bridge is guarded by an allowlist so the renderer
 * cannot call arbitrary ipcMain handlers — only the channels listed below.
 */

import { contextBridge, ipcRenderer } from "electron";

// ---------------------------------------------------------------------------
// IPC channel allowlists — ONLY these channels may be used via the generic
// invoke/on/send bridge. Every channel MUST have a registered ipcMain.handle()
// or ipcMain.on() in the main process. Update these sets when adding new IPC.
// ---------------------------------------------------------------------------

const ALLOWED_INVOKE_CHANNELS = new Set([
  // Window visibility / onboarding
  "show_main_window",
  "enter_onboarding_mode",
  "exit_onboarding_mode",

  // Folder dialog (snake_case alias)
  "show_folder_dialog",

  // Backend connection
  "get_backend_port",

  // CLI / environment checks (snake_case aliases)
  "check_cli_tool",
  "check_gh_auth",
  "get_installed_apps",
  "open_in_app",

  // Browser <webview> — only pieces that must run on the main side.
  //   - Emulation: needs `webContents.debugger.attach` + CDP commands.
  //   - DevTools: the renderer-side <webview>.openDevTools() has no mode
  //     parameter; opening docked requires webContents.openDevTools({mode}).
  "browser_webview_emulation_set",
  "browser_webview_emulation_clear",
  "browser_webview_devtools_open",
  "browser_webview_devtools_close",

  // Native operations (called via generic invoke from platform layer)
  "native:pickFolder",
  "native:setZoom",
  "native:setTitle",
  "native:homeDir",

  // iOS Simulator — all operations moved to backend (q:command protocol).
  // No IPC channels needed.
]);

const ALLOWED_EVENT_CHANNELS = new Set([
  // Window state
  "fullscreen-change",

  // Backend lifecycle
  "backend:port-changed",

  // Workspace progress
  "workspace:progress",

  // File system events
  "fs:changed",

  // PTY events
  "pty-data",
  "pty-exit",

  // Browser — only popup requests (window.open / target="_blank") need
  // main→renderer forwarding. Everything else about the <webview> (load,
  // title, url, console, keyboard) is received directly as DOM events on
  // the element in the renderer, with no main-process round-trip.
  "browser:new-tab-requested",

  // Simulator events — all moved to backend WS (q:event protocol)

  // Chat insert events
  "chat-insert",

  // Git operations
  "git-clone-progress",

  // Auto-update state
  "update:state",
]);

const electronAPI = {
  // ---------------------------------------------------------------------------
  // Backend connection info (renderer needs this to connect WebSocket)
  // ---------------------------------------------------------------------------

  getBackendPort: (): Promise<number> => ipcRenderer.invoke("native:getBackendPort"),
  getAuthToken: (): Promise<string> => ipcRenderer.invoke("native:getAuthToken"),

  // ---------------------------------------------------------------------------
  // Native OS operations
  // ---------------------------------------------------------------------------

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("native:pickFolder"),
  confirm: (message: string, detail?: string): Promise<boolean> =>
    ipcRenderer.invoke("native:confirm", { message, detail }),
  setTheme: (theme: "light" | "dark" | "system"): Promise<void> =>
    ipcRenderer.invoke("native:setTheme", { theme }),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("native:openExternal", { url }),
  openTerminal: (command: string): Promise<void> =>
    ipcRenderer.invoke("native:openTerminal", { command }),
  contextMenu: (
    items: Array<{ id: string; label: string; type?: string; enabled?: boolean }>
  ): Promise<string | null> => ipcRenderer.invoke("native:contextMenu", { items }),

  // ---------------------------------------------------------------------------
  // Window visibility & control
  // ---------------------------------------------------------------------------

  showMainWindow: (): Promise<void> => ipcRenderer.invoke("show_main_window"),
  minimize: (): Promise<void> => ipcRenderer.invoke("native:minimize"),
  maximize: (): Promise<void> => ipcRenderer.invoke("native:maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("native:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("native:isMaximized"),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("native:isFullscreen"),
  toggleFullscreen: (): Promise<void> => ipcRenderer.invoke("native:toggleFullscreen"),

  // ---------------------------------------------------------------------------
  // Auto-update
  // ---------------------------------------------------------------------------

  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke("update:check"),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke("update:download"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("update:install"),
  getUpdateState: (): Promise<unknown> => ipcRenderer.invoke("update:getState"),
  onUpdateState: (callback: (state: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: unknown): void => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },

  // ---------------------------------------------------------------------------
  // CLI / Environment checks
  // ---------------------------------------------------------------------------

  checkCliTool: (tool: string): Promise<{ installed: boolean; path: string | null }> =>
    ipcRenderer.invoke("native:checkCliTool", { tool }),
  checkGhAuth: (): Promise<{ authenticated: boolean }> => ipcRenderer.invoke("native:checkGhAuth"),
  getInstalledApps: (): Promise<Array<{ name: string; path: string }>> =>
    ipcRenderer.invoke("native:getInstalledApps"),
  openInApp: (appPath: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("native:openInApp", { appPath, filePath }),

  // ---------------------------------------------------------------------------
  // App info
  // ---------------------------------------------------------------------------

  getAppVersion: (): Promise<string> => ipcRenderer.invoke("native:getAppVersion"),
  getPlatform: (): Promise<string> => ipcRenderer.invoke("native:getPlatform"),

  // ---------------------------------------------------------------------------
  // Generic IPC bridge — guarded by allowlist to prevent the renderer from
  // calling arbitrary ipcMain handlers. Only channels listed in
  // ALLOWED_INVOKE_CHANNELS / ALLOWED_EVENT_CHANNELS are permitted.
  // ---------------------------------------------------------------------------

  invoke: (channel: string, args?: unknown): Promise<unknown> => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC invoke channel "${channel}" is not allowed`));
    }
    return ipcRenderer.invoke(channel, args);
  },
  on: (event: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (!ALLOWED_EVENT_CHANNELS.has(event)) {
      console.warn(`[preload] Event channel "${event}" is not allowed`);
      return () => {};
    }
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => callback(...args);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  send: (channel: string, ...args: unknown[]): void => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      console.warn(`[preload] Send channel "${channel}" is not allowed`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },

  // ---------------------------------------------------------------------------
  // Backend lifecycle (main process sends this after backend crash + restart)
  // ---------------------------------------------------------------------------

  onBackendPortChanged: (callback: (payload: { port: number }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { port: number }): void =>
      callback(payload);
    ipcRenderer.on("backend:port-changed", listener);
    return () => ipcRenderer.removeListener("backend:port-changed", listener);
  },

  // ---------------------------------------------------------------------------
  // Fullscreen state (main process sends this on enter/leave-full-screen)
  // ---------------------------------------------------------------------------

  onFullscreenChange: (callback: (payload: { isFullscreen: boolean }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { isFullscreen: boolean }): void =>
      callback(payload);
    ipcRenderer.on("fullscreen-change", listener);
    return () => ipcRenderer.removeListener("fullscreen-change", listener);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
