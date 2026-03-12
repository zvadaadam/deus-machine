/**
 * Tauri Platform API
 * Public exports for Tauri-specific platform features
 */

export { invoke, listen, emit, isTauriAvailable, isTauriEnv } from "./invoke";
export { createListenerGroup } from "./listenerGroup";
export * from "./commands";
// Re-export event catalog for convenient `import { SESSION_MESSAGE, listen } from "@/platform/tauri"`
export * from "@shared/events";
