// Engine primitives — shared core used by both the CLI and the SDK.
// No CLI imports, no SDK imports.

export type {
  AccessibilityNode,
  AppInfo,
  AppState,
  AppType,
  CommandExecutor,
  ExecOptions,
  ExecResult,
  Frame,
  PermissionAction,
  PermissionService,
  Point,
  RefEntry,
  Simulator,
  SimBridgeRequest,
  SimBridgeResponse,
  CommandResult,
  Snapshot,
  SnapshotNode,
  SnapshotCounts,
} from "./types.js";

export {
  DeviceUseError,
  SimctlError,
  SimBridgeError,
  ValidationError,
  DependencyError,
} from "./errors.js";

export {
  listSimulators,
  resolveSimulator,
  bootSimulator,
  shutdownSimulator,
  installApp,
  launchApp,
  terminateApp,
  takeScreenshot,
  openUrl,
  uninstallApp,
  getBootedSimulator,
  eraseSimulator,
  listApps,
  getAppState,
  setPermission,
} from "./simctl.js";

export { fetchAccessibilityTree } from "./accessibility.js";

export {
  tap,
  tapById,
  tapByLabel,
  tapEntry,
  typeText,
  swipe,
  pressKey,
  pressButton,
} from "./interaction.js";

export {
  callSimBridge,
  isBridgeAvailable,
  findBridgePath,
  findInspectorPath,
  SIMBRIDGE_ENV,
} from "./simbridge.js";

export { RefMap } from "./snapshot/refs.js";
export { buildSnapshot } from "./snapshot/build.js";
export type { BuildSnapshotOptions } from "./snapshot/build.js";
export { filterInteractive, filterTree, findInTree, isInteractive } from "./snapshot/filter.js";
export { formatCompact, formatTree } from "./snapshot/format.js";
export { diffSnapshots, formatDiff } from "./snapshot/diff.js";
export type { SnapshotDiff, SnapshotDiffEntry } from "./snapshot/diff.js";

export { waitFor, waitForLabel, waitForId, waitForType } from "./wait-for.js";
export type { WaitForOptions, WaitForResult, WaitForPredicate } from "./wait-for.js";

export { createExecutor } from "./utils/exec.js";

export { getProjectInfo, XcodebuildError } from "./project-info.js";
export type { ProjectInfo } from "./project-info.js";

export { build, resolveAppPath, BuildError } from "./xcodebuild.js";
export type { BuildOptions, BuildResult, Spawner as BuildSpawner } from "./xcodebuild.js";

export { streamLogs } from "./logs.js";
export type { StreamLogsOptions, LogStreamHandle, Spawner as LogSpawner } from "./logs.js";
