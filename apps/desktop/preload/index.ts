/**
 * Preload Script — Main Window
 *
 * Exposes a typed API to the renderer via contextBridge.
 * This is the ONLY way the renderer communicates with the main process.
 *
 * Security: contextIsolation=true, nodeIntegration=false, sandbox=false (ESM preload requires sandbox=false).
 * The renderer has zero direct access to Node.js or Electron APIs.
 *
 * The generic invoke/on bridge is guarded by an allowlist so the renderer
 * cannot call arbitrary ipcMain handlers — only the channels listed below.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { UpdateCheckResult, UpdateState } from "../../../shared/types/updates";

// ---------------------------------------------------------------------------
// IPC channel allowlists — ONLY these channels may be used via the generic
// invoke/on bridge. Every channel MUST have a registered ipcMain.handle()
// or ipcMain.on() in the main process. Update these sets when adding new IPC.
// ---------------------------------------------------------------------------

const ALLOWED_INVOKE_CHANNELS = new Set([
  // Window visibility / onboarding
  "show_main_window",
  "enter_onboarding_mode",
  "exit_onboarding_mode",

  // CLI / environment checks
  "check_cli_tool",
  "start_gh_auth_login",
  "logout_gh_auth",
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

  // Connect browser — inject decrypted cookies from a real profile into the
  // persist:browser session. Read/decrypt happens in the backend; only the
  // native session write lives on the main side. Clear wipes that session.
  "browser_import_cookies",
  "browser_clear_session",

  // Native operations (called via generic invoke from platform layer)
  "native:pickFolder",
  "native:setZoom",
  "native:homeDir",
  "native:openExternal",
  "native:openPath",
  "native:revealInFinder",
]);

const ALLOWED_EVENT_CHANNELS = new Set([
  // Backend lifecycle
  "backend:port-changed",

  // Browser — only popup requests (window.open / target="_blank") need
  // main→renderer forwarding. Everything else about the <webview> (load,
  // title, url, console, keyboard) is received directly as DOM events on
  // the element in the renderer, with no main-process round-trip.
  "browser:new-tab-requested",
]);

const electronAPI = {
  // ---------------------------------------------------------------------------
  // Backend connection info (renderer needs this to connect WebSocket)
  // ---------------------------------------------------------------------------

  getBackendPort: (): Promise<number> => ipcRenderer.invoke("native:getBackendPort"),

  // ---------------------------------------------------------------------------
  // Native OS operations
  // ---------------------------------------------------------------------------

  confirm: (message: string, detail?: string): Promise<boolean> =>
    ipcRenderer.invoke("native:confirm", { message, detail }),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("native:openExternal", { url }),

  // ---------------------------------------------------------------------------
  // Window state
  // ---------------------------------------------------------------------------

  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke("native:isFullscreen"),

  // ---------------------------------------------------------------------------
  // Auto-update
  // ---------------------------------------------------------------------------

  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke("update:check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("update:install"),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke("update:getState"),
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdateState): void => callback(state);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  },

  // ---------------------------------------------------------------------------
  // Deus Cloud account
  // ---------------------------------------------------------------------------

  getDeusCloudSession: (): Promise<unknown> => ipcRenderer.invoke("deus_cloud:get_session"),
  mintDeusCloudDirectToken: (providerSessionId: string): Promise<unknown> =>
    ipcRenderer.invoke("deus_cloud:mint_direct_token", providerSessionId),
  startDeusCloudLogin: (): Promise<unknown> => ipcRenderer.invoke("deus_cloud:start_login"),
  signOutDeusCloud: (): Promise<unknown> => ipcRenderer.invoke("deus_cloud:sign_out"),
  retryDeusCloudProvision: (): Promise<unknown> => ipcRenderer.invoke("deus_cloud:retry_provision"),
  // An organization id, or nothing for the default organization.
  getGithubAppStatus: (orgId?: string): Promise<unknown> =>
    ipcRenderer.invoke("deus_cloud:github_app_status", orgId),
  installGithubApp: (orgId?: string): Promise<unknown> =>
    ipcRenderer.invoke("deus_cloud:github_app_install", orgId),
  onDeusCloudAuthChanged: (callback: (session: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, session: unknown): void => callback(session);
    ipcRenderer.on("deus_cloud:changed", listener);
    return () => ipcRenderer.removeListener("deus_cloud:changed", listener);
  },

  // ---------------------------------------------------------------------------
  // App info
  // ---------------------------------------------------------------------------

  getAppVersion: (): Promise<string> => ipcRenderer.invoke("native:getAppVersion"),

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
