declare module "device-use/engine" {
  type AccessibilityNode =
    import("../../../packages/device-use/src/engine/types").AccessibilityNode;
  type AppInfo = import("../../../packages/device-use/src/engine/types").AppInfo;
  type CommandExecutor = import("../../../packages/device-use/src/engine/types").CommandExecutor;
  type ExecOptions = import("../../../packages/device-use/src/engine/types").ExecOptions;
  type Simulator = import("../../../packages/device-use/src/engine/types").Simulator;
  type Snapshot = import("../../../packages/device-use/src/engine/types").Snapshot;
  type CreateExecutorOptions = Omit<ExecOptions, "env"> & {
    env?: Record<string, string | undefined>;
  };

  interface BuildSnapshotOptions {
    interactiveOnly?: boolean;
    startCounter?: number;
    refMap?: unknown;
    includeHidden?: boolean;
  }

  export const createExecutor: (options?: CreateExecutorOptions) => CommandExecutor;
  export const listSimulators: (
    executor: CommandExecutor,
    opts?: { booted?: boolean }
  ) => Promise<Simulator[]>;
  export const takeScreenshot: (
    executor: CommandExecutor,
    udid: string,
    outputPath: string,
    options?: { format?: "png" | "jpeg" }
  ) => Promise<void>;
  export const fetchAccessibilityTree: (udid: string) => Promise<AccessibilityNode[]>;
  export const buildSnapshot: (
    tree: AccessibilityNode[],
    options?: BuildSnapshotOptions
  ) => Snapshot;
  export const formatTree: (tree: Snapshot["tree"]) => string;
  export const installApp: (
    executor: CommandExecutor,
    udid: string,
    appPath: string
  ) => Promise<void>;
  export const launchApp: (
    executor: CommandExecutor,
    udid: string,
    bundleId: string,
    args?: string[]
  ) => Promise<string>;
  export const listApps: (
    executor: CommandExecutor,
    udid: string,
    options?: { type?: "User" | "System" | "all" }
  ) => Promise<AppInfo[]>;
}
