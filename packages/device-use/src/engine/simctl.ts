import type { AppInfo, CommandExecutor, Simulator } from "./types.js";
import { SimctlError } from "./errors.js";

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
  errorMsg: string
): Promise<string> {
  const result = await executor(["xcrun", "simctl", ...cmd]);
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

function shellQuote(s: string): string {
  // Conservative quoting for passing a UDID through `sh -c`.
  if (/^[A-Z0-9-]+$/i.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
