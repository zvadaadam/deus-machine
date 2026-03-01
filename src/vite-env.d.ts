/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

/** App version injected by Vite's `define` from package.json */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_PORT?: string;
  readonly VITE_DEV_BROWSER_PATH?: string;
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Compiled JS files imported as raw strings (browser inject scripts) */
declare module "*.js?raw" {
  const content: string;
  export default content;
}
