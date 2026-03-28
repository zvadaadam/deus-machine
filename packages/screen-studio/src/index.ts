// @deus/screen-studio
// Screen Studio-style camera engine and compositing for agent screen recordings.

// Camera engine — spring physics, dead zone, auto-zoom
export { CameraEngine, type CameraEngineConfig } from "./camera/index.js";
export { Spring, SPRING_PRESETS } from "./camera/index.js";
export { DeadZone, DEFAULT_DEAD_ZONE } from "./camera/index.js";

// Intent classification — converts agent events into camera targets
export { IntentClassifier, type ClassifierConfig } from "./intent/index.js";
export { ShotPlanner, type ShotPlannerConfig, type ZoomRanges } from "./intent/index.js";

// Compositor — computes render instructions (canvas-agnostic)
export { Compositor, type RenderInstructions } from "./compositor/index.js";
export { CanvasRenderer } from "./compositor/index.js";

// Interpolation utilities
export { catmullRomAt, resamplePath } from "./interpolation/index.js";
export { smoothstep, smootherstep, clamp, lerp } from "./interpolation/index.js";

// Recording
export { TimelineRecorder, generateFfmpegFilter, generateCropScaleFilter, type FrameEncoder, type TimelineFrame } from "./recorder/index.js";

// MCP adapter — maps browser tool events to camera events
export { McpToolAdapter, RESOLVE_ELEMENT_JS, type McpToolEvent, type ResolvedElement, type ElementResolver } from "./adapter/index.js";

// Frame source — abstract interface for frame capture
export { DEFAULT_CDP_CONFIG, DEFAULT_SCREENSHOT_CONFIG, DEFAULT_VNC_CONFIG, type FrameSource, type Frame, type FrameCallback } from "./source/index.js";

// Recording session — full pipeline orchestrator
export { RecordingSession, type RecordingSessionConfig, type SessionStatus, type TickResult } from "./session/index.js";

// MCP server
export { createMcpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session-manager.js";
export { FfmpegRecorder, detectFfmpeg, detectCaptureMethod, detectScreenDevice, hasFilter, buildCaptureArgs, buildPostProcessArgs } from "./mcp/ffmpeg-recorder.js";

// Types
export type {
  Point,
  Size,
  Rect,
  CameraTransform,
  CameraState,
  SpringConfig,
  DeadZoneConfig,
  AgentEvent,
  AgentEventType,
  Intent,
  IntentType,
  CursorState,
  TimedTransform,
  CompositorConfig,
  DeviceFrameConfig,
  BackgroundConfig,
  CursorConfig,
  DeviceFrameType,
} from "./types.js";
