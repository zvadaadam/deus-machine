import { dirname, join } from "node:path";
import { deviceHubStatus } from "@shared/api/device-hub";
import type { DeviceSupport } from "@shared/types/device-hub";
import { getSessionRaw } from "../../db/queries";
import { DB_PATH, getDatabase } from "../../lib/database";
import { publish } from "../streams";
import { DeviceHub } from "./manager";
import { agentDeviceVersion, deviceToolchains, hubVersion, liveViewSupport } from "./support";

export const deviceHub = new DeviceHub({
  get directory() {
    return join(dirname(DB_PATH), "device-hub");
  },
  changed: (status, scope) => publish(deviceHubStatus, scope, status),
});

export function agentDeviceFor(sessionId: string) {
  const workspace = getSessionRaw(getDatabase(), sessionId)?.workspace_id;
  return {
    session: workspace ?? sessionId,
    target: workspace ? deviceHub.displayedDevice(workspace) : null,
  };
}

export async function deviceSupport(remote: boolean): Promise<DeviceSupport> {
  const [{ installer, xcode, android }, setup] = await Promise.all([
    deviceToolchains(),
    deviceHub.setupState(),
  ]);
  const liveView = liveViewSupport(process.platform, process.arch, installer, remote);
  const error = !remote && deviceHub.status.phase === "error" ? deviceHub.status.detail : null;
  return { liveView, setup, error, xcode, android, hubVersion, agentDeviceVersion };
}
