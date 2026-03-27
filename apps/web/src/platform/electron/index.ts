/**
 * Electron Platform API
 * Public exports for Electron-specific platform features.
 */

export { invoke, listen, emit, isElectronEnv } from "./invoke";
export { createListenerGroup } from "./listenerGroup";
export * from "./commands";
// Re-export event catalog for convenient `import { SESSION_MESSAGE, listen } from "@/platform/electron"`
export * from "@shared/events";
