export type { InspectorNode, InspectorSnapshot, SimulatorInfo } from "@shared/types/simulator";

export interface StreamInfo {
  url: string;
  port: number;
  /** Whether HID client is available for touch/scroll/key injection */
  hid_available: boolean;
}

export interface InstalledApp {
  bundle_id: string;
  name: string;
  app_path: string;
}
