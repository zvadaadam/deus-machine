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

export interface InspectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InspectorNode {
  id: string;
  parentId?: string;
  className: string;
  label?: string;
  identifier?: string;
  frame: InspectorRect;
  screenRect: InspectorRect;
  alpha: number;
  hidden: boolean;
  userInteractionEnabled: boolean;
  properties?: Record<string, string>;
  children: InspectorNode[];
}

export interface InspectorSnapshot {
  bundleId: string;
  pid: number;
  timestamp: number;
  roots: InspectorNode[];
  source?: "native" | "accessibility";
}
