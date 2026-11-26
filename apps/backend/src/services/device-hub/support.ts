import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceSupport } from "@shared/types/device-hub";
import rootPackage from "../../../../../package.json";
import manifest from "../../../../../resources/device-hub/package.json";
import { readXcode } from "./simctl";
import { findAndroidSdk } from "./android-sdk";

export const hubVersion = manifest.dependencies["expo-device-hub"];
export const agentDeviceVersion = rootPackage.dependencies["agent-device"];

export function hubManifest() {
  return process.env.DEUS_RESOURCES_PATH
    ? join(process.env.DEUS_RESOURCES_PATH, "app.asar.unpacked/resources/device-hub")
    : fileURLToPath(new URL("../../../../../resources/device-hub/", import.meta.url));
}

async function hasInstaller() {
  const candidates = process.env.DEUS_RUNTIME_EXECUTABLE
    ? [process.env.DEUS_RUNTIME_EXECUTABLE]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, "bun"));
  try {
    await Promise.all([
      access(join(hubManifest(), "bun.lock")),
      access(join(hubManifest(), "package.json")),
      Promise.any(candidates.map((path) => access(path, constants.X_OK))),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function liveViewSupport(
  platform: NodeJS.Platform,
  arch: string,
  installer: boolean
): Exclude<DeviceSupport["liveView"], "remote"> {
  if (platform !== "darwin" || arch !== "arm64") return "unsupported";
  return installer ? "available" : "no-runtime";
}

async function probe() {
  const [xcode, androidSdk, installer] = await Promise.all([
    readXcode(),
    findAndroidSdk(),
    hasInstaller(),
  ]);
  return { xcode, androidSdk, installer };
}

let cache: { until: number; result: ReturnType<typeof probe> } | undefined;
export function deviceToolchains() {
  if (!cache || Date.now() >= cache.until) cache = { until: Date.now() + 60_000, result: probe() };
  return cache.result;
}

export async function hasSimulatorToolchain() {
  return (await deviceToolchains()).xcode.available;
}
