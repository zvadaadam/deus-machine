import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createBackendChildEnv } from "@shared/lib/child-env";
import { simulatorEnv } from "./xcode-env";

const exec = promisify(execFile);

export function simctl(args: string[], { timeout = 5000 } = {}) {
  return exec("xcrun", ["simctl", ...args], {
    env: simulatorEnv(createBackendChildEnv()),
    timeout,
  });
}

export async function readXcode() {
  if (process.platform !== "darwin") return { available: false, version: null };
  try {
    const { stdout } = await exec("xcrun", ["--find", "simctl"], {
      env: simulatorEnv(createBackendChildEnv()),
      timeout: 5000,
    });
    const plist = resolve(dirname(stdout.trim()), "../../../Info.plist");
    const version = await exec(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", plist],
      { timeout: 5000 }
    ).then(
      ({ stdout }) => stdout.trim() || null,
      () => null
    );
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

export async function listDevices() {
  const { stdout } = await simctl(["list", "devices", "available", "-j"], { timeout: 30_000 });
  const { devices } = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
  return Object.entries(devices)
    .filter(([runtime]) => runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-"))
    .flatMap(([runtime, rows]) =>
      rows
        .filter((d) => d.isAvailable)
        .map((d) => ({
          ...d,
          runtime: "iOS " + runtime.slice(runtime.lastIndexOf("iOS-") + 4).replaceAll("-", "."),
        }))
    );
}

/** launchd_sim is a new process on each boot. The UDID survives the reboot. */
export async function bootIdentity(udid: string) {
  const { stdout } = await simctl(["spawn", udid, "launchctl", "managerpid"]);
  const pid = Number(stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
