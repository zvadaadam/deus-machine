/**
 * Preload Script — Main Window
 *
 * Exposes a typed API to the renderer via contextBridge.
 * This is the ONLY way the renderer communicates with the main process.
 *
 * Security: contextIsolation=true, nodeIntegration=false, sandbox=false (ESM preload requires sandbox=false).
 * The renderer has zero direct access to Node.js or Electron APIs.
 */

import { contextBridge, ipcRenderer } from "electron";

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
  contextMenu: (
    items: Array<{ id: string; label: string; type?: string; enabled?: boolean }>
  ): Promise<string | null> => ipcRenderer.invoke("native:contextMenu", { items }),

  // ---------------------------------------------------------------------------
  // Window visibility & control
  // ---------------------------------------------------------------------------

  showMainWindow: (): Promise<void> => ipcRenderer.invoke("native:showMainWindow"),
  enterOnboardingMode: (): Promise<void> => ipcRenderer.invoke("native:enterOnboardingMode"),
  exitOnboardingMode: (): Promise<void> => ipcRenderer.invoke("native:exitOnboardingMode"),
  minimize: (): Promise<void> => ipcRenderer.invoke("native:minimize"),
  maximize: (): Promise<void> => ipcRenderer.invoke("native:maximize"),
  close: (): Promise<void> => ipcRenderer.invoke("native:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("native:isMaximized"),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("native:isFullscreen"),
  toggleFullscreen: (): Promise<void> => ipcRenderer.invoke("native:toggleFullscreen"),

  // ---------------------------------------------------------------------------
  // Browser views (for agent browser automation)
  // ---------------------------------------------------------------------------

  browserInvoke: (method: string, args: unknown): Promise<unknown> =>
    ipcRenderer.invoke(`browser:${method}`, args),
  onBrowserEvent: (event: string, callback: (...args: unknown[]) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => callback(...args);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },

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
  // Generic IPC (for commands not yet ported to specific handlers)
  // ---------------------------------------------------------------------------

  invoke: (channel: string, args?: unknown): Promise<unknown> => ipcRenderer.invoke(channel, args),
  on: (event: string, callback: (...args: unknown[]) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => callback(...args);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  send: (channel: string, ...args: unknown[]): void => ipcRenderer.send(channel, ...args),

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
