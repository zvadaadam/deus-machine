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
    isFullscreen: () => Promise<boolean>;
    onFullscreenChange: (callback: (payload: { isFullscreen: boolean }) => void) => () => void;
    getAppVersion: () => Promise<string>;
    checkForUpdates: () => Promise<import("@shared/types/updates").UpdateCheckResult>;
    getUpdateState: () => Promise<import("@shared/types/updates").UpdateState>;
    installUpdate: () => Promise<void>;
    onUpdateState: (
      callback: (state: import("@shared/types/updates").UpdateState) => void
    ) => () => void;
    openExternal: (url: string) => Promise<void>;
    confirm: (message: string, detail?: string) => Promise<boolean>;
    getDeusCloudSession: () => Promise<import("@shared/types").DeusCloudSessionStatus>;
    startDeusCloudLogin: () => Promise<{
      success: boolean;
      session: import("@shared/types").DeusCloudSessionStatus;
      error?: string;
    }>;
    signOutDeusCloud: () => Promise<{
      success: boolean;
      session: import("@shared/types").DeusCloudSessionStatus;
      error?: string;
    }>;
    retryDeusCloudProvision: () => Promise<{ ok: boolean; error?: string }>;
    onDeusCloudAuthChanged: (
      callback: (session: import("@shared/types").DeusCloudSessionStatus) => void
    ) => () => void;
    on: (event: string, callback: (...args: unknown[]) => void) => () => void;
    invoke: (channel: string, args?: unknown) => Promise<unknown>;
  };
}
