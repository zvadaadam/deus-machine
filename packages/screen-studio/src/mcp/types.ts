import type { AgentEvent, BackgroundConfig, DeviceFrameType, Size } from "../types.js";

// ---------------------------------------------------------------------------
// Recording session config (MCP tool parameters)
// ---------------------------------------------------------------------------

export interface RecordingStartParams {
  /** Where to write the final MP4. Default: /tmp/recording-{timestamp}.mp4 */
  outputPath?: string;
  /** Source capture resolution width. Default: 1280 (agent-browser viewport) */
  sourceWidth?: number;
  /** Source capture resolution height. Default: 720 (agent-browser viewport) */
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
  /** Screen capture method. Default: "none"
   * - "avfoundation": macOS native 30fps (needs Screen Recording permission)
   * - "stream": WebSocket stream from agent-browser, 10fps, no permission needed
   * - "x11grab": Linux/Xvfb
   * - "auto": try stream (if available), then avfoundation, fall back to none
   * - "none": events-only (no video output)
   */
  captureMethod?: "x11grab" | "avfoundation" | "stream" | "auto" | "none";
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
  captureMethod: "x11grab" | "avfoundation" | "stream" | "auto" | "none";
  display: string;
}

export interface RecordingResult {
  outputPath: string;
  /** Path to JPEG thumbnail (first frame). Empty string if unavailable. */
  thumbnailPath: string;
  duration: number;
  chapters: { title: string; time: number }[];
  events: { type: string; time: number; text?: string; url?: string; direction?: string }[];
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
