// @deus/screen-studio
// Record what an agent does — a browser tab, an iOS Simulator, a display —
// into a portable bundle of original media and timed evidence, then render
// polished, chaptered videos from it as many times as you like.

// Capture
export {
  startRecording,
  recoverBundle,
  Recording,
  DEFAULT_FPS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DURATION_MS,
  type ActionInput,
  type StartRecordingOptions,
} from "./recorder.js";
export {
  startDetached,
  stopDetached,
  runWorker,
  type DetachedStartOptions,
  type StopResult,
} from "./daemon.js";
export {
  listSources,
  parseSourceId,
  resolveSource,
  SOURCE_ID_EXAMPLES,
  type AgentBrowserSourceSpec,
  type SourceInfo,
  type SourceSpec,
} from "./capture/sources.js";
export type { BrowserSourceSpec } from "./capture/cdp.js";
export type { BrowserStreamSourceSpec } from "./capture/browser-stream.js";
export type { SimulatorSourceSpec } from "./capture/simulator.js";
export type { DisplaySourceSpec, TestPatternSourceSpec } from "./capture/ffmpeg-source.js";
export type { ActiveCapture, CaptureBackend, CaptureContext } from "./capture/backend.js";
export { importVideo, type ImportOptions } from "./import.js";
export { agentDeviceEvents } from "./adapters/agent-device.js";
export { cuaTrajectory, type CuaTrajectory } from "./adapters/cua.js";
export {
  createAgentTools,
  stopSummary,
  type AgentToolDefinition,
  type AgentToolHost,
  type AgentToolOptions,
  type AgentToolResult,
  type RecordTarget,
  type StopSummary,
} from "./agent-tools.js";
export { doctor, type DoctorCheck } from "./doctor.js";

// Bundle
export {
  appendEvents,
  bundlePath,
  makeEvent,
  readEvents,
  readManifest,
  BUNDLE_FILES,
} from "./bundle/bundle.js";
export * from "./bundle/schema.js";

// Editing and direction
export { buildTimeline, type Timeline, type TimelineAction } from "./edit/timeline.js";
export { EditMap, type EditSegment } from "./edit/edit-map.js";
export {
  planPacing,
  PACING_LEVELS,
  type PacingMode,
  type PacingPlan,
  type PacingTokens,
} from "./edit/pacing.js";
export { analyzeMotion, measureChanges, type MotionAnalysis } from "./edit/motion.js";
export {
  mapChapters,
  chaptersToWebVtt,
  chaptersToFfmetadata,
  type OutputChapter,
} from "./edit/chapters.js";
export {
  planShots,
  fitCamera,
  coverage,
  type Camera,
  type Shot,
  type ShotPlan,
} from "./direct/shots.js";
export { cameraTrack } from "./direct/camera.js";
export {
  pointerTrack,
  touchTrack,
  bezier,
  type CursorFrame,
  type TouchFrame,
} from "./direct/cursor.js";
export {
  PRESETS,
  BACKGROUNDS,
  DEFAULT_PRESET,
  type Preset,
  type CursorStyle,
  type FrameStyle,
} from "./direct/presets.js";
export { Spring, SPRING_PRESETS, type SpringConfig } from "./direct/spring.js";

// Rendering
export {
  renderBundle,
  type RenderOptions,
  type RenderResult,
  type RenderPlan,
  type RenderedEvent,
} from "./render/render.js";
export { inspectBundle, contactSheet, type InspectResult } from "./render/inspect.js";
export { POINTERS, type PointerAsset } from "./render/cursors.js";

export { ScreenStudioError, toErrorInfo, type ErrorCode, type ErrorInfo } from "./errors.js";
export { parseDuration, parseBytes, parseSize, type Size } from "./util/units.js";
