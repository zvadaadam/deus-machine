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

export interface HubInventory {
  devices: HubDevice[];
  available: { ios: boolean; android: boolean };
  detail: Record<HubDevice["platform"], string | null>;
}

export interface DeviceSupport {
  liveView: "available" | "unsupported" | "no-runtime" | "remote";
  setup: "new" | "working" | "ready" | "failed";
  error: string | null;
  xcode: { available: boolean; version: string | null };
  android: boolean;
  hubVersion: string;
  agentDeviceVersion: string;
}
