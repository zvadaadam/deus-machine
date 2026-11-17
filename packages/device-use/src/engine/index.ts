// What Deus calls: the backend (simulator-context.ts) and the agents'
// simulator tools (apps/agent-server/agents/deus-tools/sim-ops.ts, typed by
// apps/agent-server/types/device-use-engine.d.ts).

export type {
  AccessibilityNode,
  AppInfo,
  CommandExecutor,
  ExecOptions,
  ExecResult,
  Simulator,
  SimBridgeRequest,
  SimBridgeResponse,
  Snapshot,
  SnapshotNode,
} from "./types.js";

export { SimctlError, SimBridgeError, DependencyError } from "./errors.js";

export { listSimulators, installApp, launchApp, takeScreenshot, listApps } from "./simctl.js";

export { fetchAccessibilityTree } from "./accessibility.js";

export { callSimBridge, findBridgePath, findInspectorPath, simulatorEnv } from "./simbridge.js";

export { buildSnapshot } from "./snapshot/build.js";
export type { BuildSnapshotOptions } from "./snapshot/build.js";
export { formatTree } from "./snapshot/format.js";

export { createExecutor } from "./utils/exec.js";
