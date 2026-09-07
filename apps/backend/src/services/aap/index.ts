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
  prefetchInstalledAppAssets,
} from "./apps.service";
