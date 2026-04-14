/**
 * Electron Platform API
 * Public exports for Electron-specific platform features.
 */

export { invoke, listen, isElectronEnv } from "./invoke";
export * from "./commands";
// Re-export event catalog for convenient `import { SESSION_MESSAGE, listen } from "@/platform/electron"`
export * from "@shared/events";
