export const HUB_STREAM_MODE = "h264";

export type HubStatus =
  | { phase: "idle" | "installing" | "starting" }
  | { phase: "ready"; instance: string }
  | { phase: "error"; message: string };

export interface HubDevice {
  platform: "ios" | "android";
  id: string;
  name: string;
  version: string;
  booted: boolean;
}
