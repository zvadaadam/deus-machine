export const HUB_STREAM_MODE = "webrtc";

export type HubStatus =
  | { phase: "idle" | "installing" | "starting" }
  | { phase: "ready"; instance: string }
  | { phase: "error"; message: string; detail: string };

export interface HubDevice {
  platform: "ios" | "android";
  id: string;
  name: string;
  version: string;
  booted: boolean;
}

export function deviceIdentity(device: HubDevice) {
  return device.platform === "ios" ? device.id : device.name;
}

export interface HubInventory {
  devices: HubDevice[];
  available: { ios: boolean; android: boolean };
  detail: Record<HubDevice["platform"], string | null>;
}

export interface DeviceSetup {
  setup: "new" | "working" | "ready" | "failed";
  error: string | null;
}

export type DeviceSupport =
  | { liveView: "remote" }
  | {
      liveView: "available" | "unsupported" | "no-runtime";
      xcode: { available: boolean; version: string | null };
      android: boolean;
      hubVersion: string;
      agentDeviceVersion: string;
    };
