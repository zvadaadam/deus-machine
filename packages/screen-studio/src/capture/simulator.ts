import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ScreenStudioError } from "../errors.js";
import { run, tail } from "../util/process.js";
import type { Size } from "../util/units.js";
import type { ActiveCapture, CaptureBackend, CaptureContext } from "./backend.js";

export interface SimulatorSourceSpec {
  kind: "ios-simulator";
  /** A device UDID, or "booted" for the only booted device. */
  udid: string;
  /** Custom simulator device set (`simctl --set`). */
  deviceSet?: string;
}

export interface SimulatorDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceType?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a full Xcode, including ones that were never `xcode-select`ed (an Xcode
 * unpacked in ~/Downloads is common). Command Line Tools lack simctl.
 */
export async function findDeveloperDir(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.DEVELOPER_DIR) candidates.push(process.env.DEVELOPER_DIR);
  try {
    const selected = await run("xcode-select", ["-p"], { timeoutMs: 5_000 });
    if (selected.code === 0) candidates.push(selected.stdout.trim());
  } catch {
    // xcode-select missing: not macOS
  }
  for (const root of [
    "/Applications",
    join(homedir(), "Applications"),
    join(homedir(), "Downloads"),
  ]) {
    try {
      for (const entry of (await readdir(root)).sort()) {
        if (/^Xcode.*\.app$/.test(entry)) candidates.push(join(root, entry, "Contents/Developer"));
      }
    } catch {
      // directory absent
    }
  }
  for (const dir of candidates) {
    if (await exists(join(dir, "usr/bin/simctl"))) return dir;
  }
  return null;
}

let developerDirCache: Promise<string | null> | null = null;

async function simctl(args: string[], deviceSet?: string, timeoutMs = 20_000) {
  developerDirCache ??= findDeveloperDir();
  const developerDir = await developerDirCache;
  if (!developerDir) {
    throw new ScreenStudioError("tool_missing", "No Xcode with simctl found", {
      hint: "Install Xcode, or set DEVELOPER_DIR to …/Xcode.app/Contents/Developer",
    });
  }
  const env = { ...process.env, DEVELOPER_DIR: developerDir };
  const fullArgs = ["simctl", ...(deviceSet ? ["--set", deviceSet] : []), ...args];
  return { developerDir, env, fullArgs, result: () => run("xcrun", fullArgs, { env, timeoutMs }) };
}

export async function listSimulators(deviceSet?: string): Promise<SimulatorDevice[]> {
  const cmd = await simctl(["list", "devices", "--json"], deviceSet);
  const result = await cmd.result();
  if (result.code !== 0) throw new Error(`simctl list failed: ${tail(result.stderr)}`);
  const parsed = JSON.parse(result.stdout) as {
    devices: Record<
      string,
      Array<{
        udid: string;
        name: string;
        state: string;
        isAvailable?: boolean;
        deviceTypeIdentifier?: string;
      }>
    >;
  };
  return Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
    devices
      .filter((d) => d.isAvailable !== false)
      .map((d) => ({
        udid: d.udid,
        name: d.name,
        state: d.state,
        runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
        deviceType: d.deviceTypeIdentifier,
      }))
  );
}

/** Screen size in points and pixels, from the device type's capability profile. */
async function screenGeometry(
  device: SimulatorDevice
): Promise<{ viewport: Size; media: Size } | undefined> {
  if (!device.deviceType) return undefined;
  try {
    const cmd = await simctl(["list", "devicetypes", "--json"]);
    const types = JSON.parse((await cmd.result()).stdout) as {
      devicetypes: Array<{ identifier: string; bundlePath: string }>;
    };
    const type = types.devicetypes.find((t) => t.identifier === device.deviceType);
    if (!type) return undefined;
    const plist = await run("plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(type.bundlePath, "Contents/Resources/capabilities.plist"),
    ]);
    const dims = (
      JSON.parse(plist.stdout) as {
        capabilities?: { ScreenDimensionsCapability?: Record<string, number> };
      }
    ).capabilities?.ScreenDimensionsCapability;
    const scale = dims?.["main-screen-scale"];
    const width = dims?.["main-screen-width"];
    const height = dims?.["main-screen-height"];
    if (!scale || !width || !height) return undefined;
    return {
      media: { width, height },
      viewport: { width: Math.round(width / scale), height: Math.round(height / scale) },
    };
  } catch {
    return undefined;
  }
}

export async function simulatorBackend(spec: SimulatorSourceSpec): Promise<CaptureBackend> {
  const devices = await listSimulators(spec.deviceSet);
  const booted = devices.filter((d) => d.state === "Booted");
  const device =
    spec.udid === "booted"
      ? booted[0]
      : devices.find((d) => d.udid.toLowerCase() === spec.udid.toLowerCase());
  if (!device) {
    throw new ScreenStudioError(
      "source_not_found",
      spec.udid === "booted" ? "No simulator is booted" : `No simulator ${spec.udid}`,
      {
        hint: booted.length
          ? `Booted: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}`
          : "Boot one with `xcrun simctl boot <udid>` or open Simulator.app.",
      }
    );
  }
  if (device.state !== "Booted") {
    throw new ScreenStudioError("source_unavailable", `${device.name} is ${device.state}`, {
      hint: `Boot it first: xcrun simctl boot ${device.udid}`,
    });
  }
  const geometry = await screenGeometry(device);
  return {
    id: `ios-simulator:${device.udid}`,
    kind: "ios-simulator",
    backend: "simctl",
    label: `${device.name} (${device.runtime})`,
    details: {
      udid: device.udid,
      name: device.name,
      runtime: device.runtime,
      deviceSet: spec.deviceSet,
    },
    start: (context) => startSimctl(device, spec.deviceSet, geometry, context),
  };
}

const READY_TIMEOUT_MS = 20_000;

async function startSimctl(
  device: SimulatorDevice,
  deviceSet: string | undefined,
  geometry: { viewport: Size; media: Size } | undefined,
  context: CaptureContext
): Promise<ActiveCapture> {
  const path = join(context.mediaDir, "screen.mp4");
  const cmd = await simctl(
    ["io", device.udid, "recordVideo", "--codec=h264", "--force", path],
    deviceSet
  );
  const child = spawn("xcrun", cmd.fullArgs, { env: cmd.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stopping = false;
  let readyAt = 0;

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: -1, signal: null }));
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGINT");
      reject(
        new ScreenStudioError("start_timeout", "simctl did not start recording", {
          hint: tail(output),
        })
      );
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      // simctl prints this once the first video frame has been processed.
      if (!readyAt && output.includes("Recording started")) {
        readyAt = Date.now();
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    exited.then(({ code }) => {
      if (readyAt) return;
      clearTimeout(timer);
      reject(
        new ScreenStudioError("capture_failed", `simctl exited (${code}) before recording`, {
          hint: tail(output),
        })
      );
    });
  });

  exited.then(({ code, signal }) => {
    if (!stopping)
      context.onSourceLost(`simctl exited (${signal ?? code}); the simulator may have shut down`);
  });

  return {
    mediaStartEpochMs: readyAt,
    uncertaintyMs: 50,
    clockMethod: "simctl 'Recording started' (printed after the first frame is processed)",
    geometry,
    pointerInPixels: "none",
    childPids: child.pid ? [child.pid] : [],
    stats: () => ({ frames: null }),
    async stop() {
      stopping = true;
      child.kill("SIGINT");
      const escalate = setTimeout(() => child.kill("SIGTERM"), 20_000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
      await exited;
      clearTimeout(escalate);
      clearTimeout(kill);
      const size = await stat(path)
        .then((s) => s.size)
        .catch(() => 0);
      if (size === 0) {
        throw new ScreenStudioError("media_missing", "simctl produced no video", {
          hint: tail(output),
        });
      }
      // simctl only writes frames when the screen changes; a still ending is
      // shorter than the capture window. Renderers pad by holding the last frame.
      return { path, warnings: [] };
    },
  };
}
