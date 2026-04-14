/**
 * Platform Native API
 *
 * Typed, capability-gated wrappers for Electron IPC.
 * Feature code imports from here -- never from electron/invoke directly.
 *
 * In web mode, all operations gracefully no-op or return defaults.
 * No isElectronEnv checks needed in components.
 */

import * as window_ from "./window";
import * as apps from "./apps";
import * as cli from "./cli";
import * as dialog from "./dialog";
import * as browserViews from "./browser-views";
import * as events from "./events";

export const native = {
  window: window_,
  apps,
  cli,
  dialog,
  browserViews,
  events,
} as const;

// Re-export types
export type { InstalledApp } from "./apps";
export type { CliCheckResult, GhAuthResult } from "./cli";
