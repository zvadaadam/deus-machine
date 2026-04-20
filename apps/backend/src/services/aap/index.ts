// apps/backend/src/services/aap/index.ts
// Barrel — only export the public surface. Everything else is internal.

export {
  listApps,
  getRunningApps,
  launchApp,
  stopApp,
  stopAppsForWorkspace,
  stopAllApps,
  sweepOrphanApps,
  readAppSkill,
} from "./apps.service";

// Re-export the public view + contract types from shared so backend-internal
// callers (routes, query-engine, agent-server RPC bridge) can grab them from
// `./services/aap` without reaching into shared directly. The source of
// truth is `@shared/aap/types`.
export type {
  InstalledApp,
  RunningApp,
  RunningStatus,
  LaunchAppArgs,
  LaunchAppResult,
  AppsLaunchedEvent,
} from "@shared/aap/types";
