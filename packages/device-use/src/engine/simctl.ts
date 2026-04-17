import type {
  AppInfo,
  AppState,
  CommandExecutor,
  ExecOptions,
  PermissionAction,
  PermissionService,
  Simulator,
} from "./types.js";
import { SimctlError, ValidationError } from "./errors.js";

interface SimctlListOutput {
  devices: Record<string, SimctlDevice[]>;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

function runtimeVersion(runtimeId: string): string {
  // "com.apple.CoreSimulator.SimRuntime.iOS-18-0" → "18.0"
  const match = runtimeId.match(/(\d+)-(\d+)(?:-(\d+))?$/);
  if (!match) return runtimeId;
  return match[3] ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`;
}

function runtimeName(runtimeId: string): string {
  // "com.apple.CoreSimulator.SimRuntime.iOS-18-0" → "iOS 18.0"
  const match = runtimeId.match(/SimRuntime\.(.+?)-([\d-]+)$/);
  if (!match) return runtimeId;
  return `${match[1]} ${runtimeVersion(runtimeId)}`;
}

async function runSimctl(
  executor: CommandExecutor,
  cmd: string[],
  errorMsg: string,
  execOpts?: ExecOptions
): Promise<string> {
  const result = await executor(["xcrun", "simctl", ...cmd], execOpts);
  if (!result.success) {
    throw new SimctlError(errorMsg, result.exitCode, result.error);
  }
  return result.output;
}

export async function listSimulators(
  executor: CommandExecutor,
  opts?: { booted?: boolean }
): Promise<Simulator[]> {
  const output = await runSimctl(
    executor,
    ["list", "devices", "available", "-j"],
    "Failed to list simulators"
  );

  const parsed = JSON.parse(output) as SimctlListOutput;

  return Object.entries(parsed.devices).flatMap(([runtimeId, devices]) =>
    devices
      .filter((d) => d.isAvailable && (!opts?.booted || d.state === "Booted"))
      .map((d) => ({
        udid: d.udid,
        name: d.name,
        state: d.state,
        runtime: runtimeName(runtimeId),
        runtimeVersion: runtimeVersion(runtimeId),
        isAvailable: d.isAvailable,
      }))
  );
}

export async function resolveSimulator(
  executor: CommandExecutor,
  nameOrUdid: string
): Promise<Simulator> {
  const simulators = await listSimulators(executor);
  const uuidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

  const isUuid = uuidPattern.test(nameOrUdid);
  const match = simulators.find((s) => (isUuid ? s.udid : s.name) === nameOrUdid);

  if (!match) {
    throw new SimctlError(
      `Simulator not found: "${nameOrUdid}". Run "device-use list" to see available simulators.`
    );
  }

  return match;
}

export async function bootSimulator(executor: CommandExecutor, udid: string): Promise<void> {
  const result = await executor(["xcrun", "simctl", "boot", udid]);
  if (!result.success) {
    if (result.error?.includes("current state: Booted")) return;
    throw new SimctlError(`Failed to boot simulator ${udid}`, result.exitCode, result.error);
  }
}

export async function shutdownSimulator(executor: CommandExecutor, udid: string): Promise<void> {
  const result = await executor(["xcrun", "simctl", "shutdown", udid]);
  if (!result.success) {
    if (result.error?.includes("current state: Shutdown")) return;
    throw new SimctlError(`Failed to shutdown simulator ${udid}`, result.exitCode, result.error);
  }
}

export async function installApp(
  executor: CommandExecutor,
  udid: string,
  appPath: string
): Promise<void> {
  await runSimctl(executor, ["install", udid, appPath], `Failed to install app: ${appPath}`);
}

export async function launchApp(
  executor: CommandExecutor,
  udid: string,
  bundleId: string,
  args?: string[]
): Promise<string> {
  const output = await runSimctl(
    executor,
    ["launch", udid, bundleId, ...(args ?? [])],
    `Failed to launch ${bundleId}`
  );
  // Output: "com.example.MyApp: 42766"
  return output.trim().split(":").pop()?.trim() ?? "";
}

export async function terminateApp(
  executor: CommandExecutor,
  udid: string,
  bundleId: string
): Promise<void> {
  await runSimctl(executor, ["terminate", udid, bundleId], `Failed to terminate ${bundleId}`);
}

export async function takeScreenshot(
  executor: CommandExecutor,
  udid: string,
  outputPath: string,
  opts?: { format?: "png" | "jpeg" }
): Promise<void> {
  const cmd = [
    "io",
    udid,
    "screenshot",
    ...(opts?.format ? ["--type", opts.format] : []),
    outputPath,
  ];
  await runSimctl(executor, cmd, "Failed to take screenshot");
}

export async function openUrl(executor: CommandExecutor, udid: string, url: string): Promise<void> {
  await runSimctl(executor, ["openurl", udid, url], `Failed to open URL: ${url}`);
}

export async function uninstallApp(
  executor: CommandExecutor,
  udid: string,
  bundleId: string
): Promise<void> {
  await runSimctl(executor, ["uninstall", udid, bundleId], `Failed to uninstall ${bundleId}`);
}

export async function getBootedSimulator(
  executor: CommandExecutor
): Promise<Simulator | undefined> {
  const simulators = await listSimulators(executor, { booted: true });
  return simulators[0];
}

export async function eraseSimulator(executor: CommandExecutor, udid: string): Promise<void> {
  await runSimctl(executor, ["erase", udid], `Failed to erase simulator ${udid}`, {
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

interface RawAppEntry {
  ApplicationType?: string;
  CFBundleIdentifier?: string;
  CFBundleDisplayName?: string;
  CFBundleName?: string;
  CFBundleVersion?: string;
  CFBundleShortVersionString?: string;
  Path?: string;
}

/**
 * List apps installed on a booted simulator. Uses `simctl listapps` piped
 * through `plutil` to convert the legacy plist output into JSON.
 */
export async function listApps(
  executor: CommandExecutor,
  udid: string,
  opts?: { type?: "User" | "System" | "all" }
): Promise<AppInfo[]> {
  // `simctl listapps` emits old-style plist (not JSON). Use a shell pipeline.
  const result = await executor([
    "sh",
    "-c",
    `xcrun simctl listapps ${shellQuote(udid)} | plutil -convert json -o - -`,
  ]);

  if (!result.success) {
    throw new SimctlError(`Failed to list apps on ${udid}`, result.exitCode, result.error);
  }

  let parsed: Record<string, RawAppEntry>;
  try {
    parsed = JSON.parse(result.output) as Record<string, RawAppEntry>;
  } catch (err) {
    throw new SimctlError(
      `Unexpected listapps output: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const wanted = opts?.type ?? "all";
  const apps: AppInfo[] = [];

  for (const [bundleId, entry] of Object.entries(parsed)) {
    const type = entry.ApplicationType === "System" ? "System" : "User";
    if (wanted !== "all" && wanted !== type) continue;
    apps.push({
      bundleId,
      name: entry.CFBundleDisplayName ?? entry.CFBundleName ?? bundleId,
      version: entry.CFBundleShortVersionString ?? entry.CFBundleVersion,
      type,
      bundlePath: entry.Path,
    });
  }

  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

/**
 * Inspect an app's install + running state.
 * Running detection greps `launchctl list` for `UIKitApplication:<bundleId>`.
 */
export async function getAppState(
  executor: CommandExecutor,
  udid: string,
  bundleId: string
): Promise<AppState> {
  // Install check: get_app_container succeeds only if the app is installed.
  const container = await executor(["xcrun", "simctl", "get_app_container", udid, bundleId]);
  const installed = container.success;

  // Running check: spawn launchctl list inside the sim and look for the bundle.
  const list = await executor(["xcrun", "simctl", "spawn", udid, "launchctl", "list"]);
  let running = false;
  let pid: number | undefined;

  if (list.success) {
    const needle = `UIKitApplication:${bundleId}`;
    for (const line of list.output.split("\n")) {
      const idx = line.indexOf(needle);
      if (idx === -1) continue;
      // Line format: "<pid>\t<status>\t<label>" — pid is "-" when not running
      const parts = line.split(/\s+/);
      const pidStr = parts[0];
      if (pidStr && pidStr !== "-") {
        const n = Number(pidStr);
        if (Number.isFinite(n)) {
          running = true;
          pid = n;
          break;
        }
      }
    }
  }

  return { bundleId, installed, running, ...(pid !== undefined ? { pid } : {}) };
}

/**
 * Grant, revoke, or reset a privacy permission for an app.
 * `bundleId` is required for grant/revoke; optional for reset (omit to reset all).
 */
export async function setPermission(
  executor: CommandExecutor,
  udid: string,
  action: PermissionAction,
  service: PermissionService,
  bundleId?: string
): Promise<void> {
  if ((action === "grant" || action === "revoke") && !bundleId) {
    throw new ValidationError(`${action} requires a bundle identifier`);
  }

  const args = ["privacy", udid, action, service];
  if (bundleId) args.push(bundleId);

  await runSimctl(executor, args, `Failed to ${action} ${service} for ${bundleId ?? "all apps"}`);
}

function shellQuote(s: string): string {
  // Conservative quoting for passing a UDID through `sh -c`.
  if (/^[A-Z0-9-]+$/i.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
