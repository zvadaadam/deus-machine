// ---------------------------------------------------------------------------
// Coordinate spaces
// ---------------------------------------------------------------------------

/** Pixel coordinates relative to the source content (e.g. 1920x1080 capture). */
export interface Point {
  x: number;
  y: number;
}

/** Width × height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Axis-aligned bounding box in pixel coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Camera state: position (center of viewport) + zoom level. */
export interface CameraTransform {
  /** X center of the camera viewport in source coordinates. */
  x: number;
  /** Y center of the camera viewport in source coordinates. */
  y: number;
  /** Zoom multiplier (1 = no zoom, 2 = 2× magnification). */
  zoom: number;
}

/** Full camera state including velocities (for spring simulation). */
export interface CameraState extends CameraTransform {
  vx: number;
  vy: number;
  vzoom: number;
}

/** Spring physics parameters. */
export interface SpringConfig {
  /** Natural frequency in rad/s. Higher = snappier response. Default: 8 */
  omega: number;
  /** Damping ratio. 0.7 = underdamped (slight overshoot). 1.0 = critically damped. Default: 0.7 */
  zeta: number;
}

/** Dead zone configuration. Camera holds still when cursor is within this region. */
export interface DeadZoneConfig {
  /** Fraction of viewport (0-1) for the safe zone. Default: 0.15 */
  fraction: number;
  /** Hysteresis band fraction (prevents chattering at boundary). Default: 0.03 */
  hysteresis: number;
}

// ---------------------------------------------------------------------------
// Agent events (input to the camera engine)
// ---------------------------------------------------------------------------

export type AgentEventType =
  | "click"
  | "type"
  | "scroll"
  | "navigate"
  | "drag"
  | "idle"
  | "screenshot";

/** A single agent action that the camera engine uses to drive zoom/pan. */
export interface AgentEvent {
  /** Event type — determines zoom behavior. */
  type: AgentEventType;
  /** Timestamp in milliseconds (monotonic). */
  t: number;
  /** Source-pixel coordinates of the action (where the agent is operating). */
  x: number;
  y: number;
  /** Optional: bounding box of the element being interacted with. */
  elementRect?: Rect;
  /** Optional: additional metadata (e.g. typed text, URL, scroll delta). */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

export type IntentType =
  | "typing"
  | "clicking"
  | "scrolling"
  | "dragging"
  | "navigating"
  | "idle";

/** A classified segment of agent activity with a zoom target. */
export interface Intent {
  type: IntentType;
  /** Start time (ms). */
  startT: number;
  /** End time (ms). */
  endT: number;
  /** Target camera center in source coordinates. */
  center: Point;
  /** Computed zoom level for this intent. */
  zoom: number;
  /** Bounding box of activity (for zoom computation). */
  bounds?: Rect;
}

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

export type DeviceFrameType = "browser-chrome" | "macos-window" | "none";

export interface DeviceFrameConfig {
  type: DeviceFrameType;
  /** Title text for the title bar (browser URL or window title). */
  title?: string;
  /** Corner radius in pixels. Default: 12 */
  cornerRadius?: number;
  /** Padding inside the frame around content. */
  padding?: { top: number; right: number; bottom: number; left: number };
}

export interface BackgroundConfig {
  type: "gradient" | "solid" | "blur";
  colors?: [string, string];
  /** Gradient angle in degrees. Default: 135 */
  angle?: number;
  /** Blur radius (only for type: "blur"). */
  blurRadius?: number;
}

export interface CursorConfig {
  /** Show cursor overlay. Default: true */
  visible: boolean;
  /** Cursor size in output pixels. Default: 24 */
  size: number;
  /** Show click ripple effect. Default: true */
  showClickRipple: boolean;
  /** Ripple duration in ms. Default: 400 */
  rippleDuration: number;
  /** Show spotlight glow behind cursor. Default: true */
  showSpotlight: boolean;
  /** Spotlight radius in pixels. Default: 40 */
  spotlightRadius: number;
  /** Spotlight color. Default: "rgba(58, 150, 221, 0.15)" */
  spotlightColor: string;
  /** Show dual-ring ripple (vs single ring). Default: true */
  dualRipple: boolean;
}

export interface CompositorConfig {
  /** Output dimensions. */
  output: Size;
  /** Source content dimensions. */
  source: Size;
  /** Device frame settings. */
  deviceFrame: DeviceFrameConfig;
  /** Background settings. */
  background: BackgroundConfig;
  /** Cursor overlay settings. */
  cursor: CursorConfig;
}

/** A single cursor state for a given frame. */
export interface CursorState {
  /** Position in source coordinates. */
  x: number;
  y: number;
  /** Whether a click is active (for ripple effect). */
  clicking: boolean;
  /** Time since click started (ms), for ripple animation. */
  clickAge: number;
  /** Whether cursor is visible. */
  visible: boolean;
  /** Cursor velocity in source pixels/s (for motion effects). */
  vx: number;
  vy: number;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** A timed camera transform for playback/recording. */
export interface TimedTransform {
  t: number;
  camera: CameraTransform;
  cursor: CursorState;
}
