export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
  device_type: string;
  is_available: boolean;
}

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
