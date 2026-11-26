import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceHubStatus } from "@shared/api/device-hub";
import type { DeviceSupport } from "@shared/types/device-hub";
import { getSessionRaw } from "../../db/queries";
import { canonicalDatabaseFile, getDatabase } from "../../lib/database";
import { publish } from "../streams";
import { DeviceHub } from "./manager";
import { agentDeviceVersion, deviceToolchains, hubVersion, liveViewSupport } from "./support";

export const deviceHub = new DeviceHub({
  get directory() {
    const database = canonicalDatabaseFile();
    return database === ":memory:"
      ? join(tmpdir(), `deus-memory-${process.pid}.device-hub`)
      : database + ".device-hub";
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
  if (remote) return { liveView: "remote" };
  const { installer, xcode, android } = await deviceToolchains();
  const liveView = liveViewSupport(process.platform, process.arch, installer);
  const setup = installer ? await deviceHub.setupState() : "new";
  const error = deviceHub.status.phase === "error" ? deviceHub.status.detail : null;
  return { liveView, setup, error, xcode, android, hubVersion, agentDeviceVersion };
}
