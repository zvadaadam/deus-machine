export interface SimulatorCapabilities {
  available: boolean;
  unavailableReason: string | null;
}

/** One iOS Simulator device installed on the backend's Mac. */
export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
  device_type: string;
  is_available: boolean;
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

/** The view tree of what a simulator shows: the app's own views, or the accessibility tree. */
export interface InspectorSnapshot {
  bundleId: string;
  pid: number;
  timestamp: number;
  roots: InspectorNode[];
  source?: "native" | "accessibility";
}

/** The platform's verdict on one cloud device verb, verbatim: a failed verb is a result, not an error. */
export interface CloudSimulatorExecResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
}
