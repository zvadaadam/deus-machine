/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

/** App version injected by Vite's `define` from package.json */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Compiled JS files imported as raw strings (browser inject scripts) */
declare module "*.js?raw" {
  const content: string;
  export default content;
}

/**
 * Electron preload bridge — available when running inside Electron.
 * Undefined in browser mode. The full typed API is defined in
 * apps/desktop/preload/index.ts and exposed via contextBridge.
 */
interface Window {
  electronAPI?: {
    getBackendPort: () => Promise<number>;
    getAuthToken: () => Promise<string>;
    isFullscreen: () => Promise<boolean>;
    onFullscreenChange: (callback: (payload: { isFullscreen: boolean }) => void) => () => void;
    getAppVersion: () => Promise<string>;
    checkForUpdates: () => Promise<unknown>;
    downloadUpdate: () => Promise<void>;
    installUpdate: () => Promise<void>;
    onUpdateState: (callback: (state: unknown) => void) => () => void;
    openTerminal: (command: string) => Promise<void>;
    on: (event: string, callback: (...args: unknown[]) => void) => () => void;
    invoke: (channel: string, args?: unknown) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
  };
}
