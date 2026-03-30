import type { AgentEvent, BackgroundConfig, DeviceFrameType, Size } from "../types.js";

// ---------------------------------------------------------------------------
// Recording session config (MCP tool parameters)
// ---------------------------------------------------------------------------

export interface RecordingStartParams {
  /** Where to write the final MP4. Default: /tmp/recording-{timestamp}.mp4 */
  outputPath?: string;
  /** Source capture resolution width. Default: 1920 */
  sourceWidth?: number;
  /** Source capture resolution height. Default: 1080 */
  sourceHeight?: number;
  /** Output video width. Default: 1920 */
  outputWidth?: number;
  /** Output video height. Default: 1080 */
  outputHeight?: number;
  /** Frame rate. Default: 30 */
  fps?: number;
  /** Device frame overlay. Default: "none" */
  deviceFrame?: DeviceFrameType;
  /** Background config. */
  background?: { type: "gradient" | "solid"; colors?: [string, string]; angle?: number };
  /** Screen capture method. "none" = events only, post-process later. Default: "none" */
  captureMethod?: "x11grab" | "avfoundation" | "screenshot" | "none";
  /** X11 display for x11grab capture. Default: ":99" */
  display?: string;
}

// ---------------------------------------------------------------------------
// Recording session state (internal)
// ---------------------------------------------------------------------------

export type RecordingStatus = "recording" | "processing" | "done" | "error";

export interface Chapter {
  title: string;
  timestamp: number;
  eventIndex: number;
}

export interface RecordingSessionState {
  id: string;
  status: RecordingStatus;
  config: ResolvedRecordingConfig;
  events: AgentEvent[];
  chapters: Chapter[];
  startTime: number;
  /** Set when session leaves "recording" state, freezes duration. */
  endTime?: number;
  outputPath?: string;
  error?: string;
}

export interface ResolvedRecordingConfig {
  outputPath: string;
  sourceSize: Size;
  outputSize: Size;
  fps: number;
  deviceFrame: DeviceFrameType;
  background: BackgroundConfig;
  captureMethod: "x11grab" | "avfoundation" | "screenshot" | "none";
  display: string;
}

export interface RecordingResult {
  outputPath: string;
  duration: number;
  eventCount: number;
  chapterCount: number;
}

// ---------------------------------------------------------------------------
// ffmpeg recorder
// ---------------------------------------------------------------------------

export interface FfmpegCaptureConfig {
  method: "x11grab" | "avfoundation";
  sourceSize: Size;
  fps: number;
  display: string;
  outputPath: string;
  /** macOS: avfoundation screen device index (auto-detected if omitted). */
  screenDevice?: string;
}

export interface FfmpegPostProcessConfig {
  inputPath: string;
  outputPath: string;
  filterComplex: string;
  outputSize: Size;
  addWatermark?: boolean;
  watermarkText?: string;
  /** Whether the drawtext filter is available in this ffmpeg build. */
  hasDrawtext?: boolean;
}
