import type { Size } from "../types.js";

/**
 * Abstract frame encoder interface.
 *
 * Platform-specific implementations:
 * - Browser: WebCodecs VideoEncoder + mp4-muxer
 * - Browser (fallback): MediaRecorder + canvas.captureStream()
 * - Server: ffmpeg child process with pipe input
 *
 * The recorder doesn't implement these directly — it defines the
 * contract so you can plug in the right backend for your platform.
 */
export interface FrameEncoder {
  /** Initialize the encoder. Call once before addFrame(). */
  init(): Promise<void>;

  /**
   * Add a frame to the recording.
   * @param frameData  Raw pixel data (RGBA) or encoded image
   * @param timestamp  Frame timestamp in microseconds
   */
  addFrame(frameData: ArrayBuffer | ImageBitmap, timestamp: number): void;

  /** Finalize the recording and return the encoded data. */
  finish(): Promise<Blob | ArrayBuffer>;

  /** Get encoder status. */
  isReady(): boolean;
}

/**
 * Timeline recorder that captures timed transforms for post-processing.
 *
 * Instead of encoding video in real-time, this captures the camera
 * timeline so you can render the final video later (with ffmpeg
 * or WebCodecs) at any quality level.
 */
export interface TimelineFrame {
  /** Timestamp in ms. */
  t: number;
  /** Camera transform at this frame. */
  camera: { x: number; y: number; zoom: number };
  /** Cursor state at this frame. */
  cursor: { x: number; y: number; clicking: boolean; visible: boolean };
}

/**
 * Simple timeline recorder — captures transforms for offline rendering.
 *
 * Usage:
 * ```ts
 * const recorder = new TimelineRecorder({ fps: 30 });
 * recorder.start();
 *
 * // During animation loop:
 * recorder.captureFrame(t, camera, cursor);
 *
 * // When done:
 * const timeline = recorder.stop();
 * // → TimelineFrame[] — pass to ffmpeg or WebCodecs for final render
 * ```
 */
export class TimelineRecorder {
  private frames: TimelineFrame[] = [];
  private recording = false;
  private fps: number;
  private lastFrameT = -Infinity;

  constructor(config: { fps?: number } = {}) {
    this.fps = config.fps ?? 30;
  }

  start(): void {
    this.frames = [];
    this.recording = true;
    this.lastFrameT = -Infinity;
  }

  captureFrame(
    t: number,
    camera: { x: number; y: number; zoom: number },
    cursor: { x: number; y: number; clicking: boolean; visible: boolean },
  ): void {
    if (!this.recording) return;

    // Enforce frame rate (skip if too soon)
    const minInterval = 1000 / this.fps;
    if (t - this.lastFrameT < minInterval * 0.9) return;

    this.frames.push({
      t,
      camera: { ...camera },
      cursor: { ...cursor },
    });
    this.lastFrameT = t;
  }

  stop(): TimelineFrame[] {
    this.recording = false;
    return this.frames;
  }

  isRecording(): boolean {
    return this.recording;
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  getDuration(): number {
    if (this.frames.length < 2) return 0;
    return this.frames[this.frames.length - 1].t - this.frames[0].t;
  }
}

/**
 * Generate an ffmpeg filter command from a timeline.
 *
 * Produces a zoompan + overlay filter string that can be passed to
 * ffmpeg to create a Screen Studio-style video from a raw recording.
 *
 * @param timeline   Array of timed transforms
 * @param sourceSize Original recording dimensions
 * @param outputSize Desired output dimensions
 * @returns          ffmpeg -filter_complex string
 */
export function generateFfmpegFilter(
  timeline: TimelineFrame[],
  sourceSize: Size,
  outputSize: Size,
): string {
  if (timeline.length === 0) return "";

  // For zoompan, we need to express zoom/position as expressions per frame.
  // Since ffmpeg expressions can't read JSON, we generate a static filter
  // that interpolates between keyframes using the 'if(between(n,...))' pattern.

  const durationSec = (timeline[timeline.length - 1].t - timeline[0].t) / 1000;
  const fps = durationSec > 0 ? Math.round(timeline.length / durationSec) : 30;

  // Sample keyframes (every 10th frame to keep filter manageable)
  const step = Math.max(1, Math.floor(timeline.length / 100));
  const keyframes: Array<{ n: number; zoom: number; x: number; y: number }> = [];

  for (let i = 0; i < timeline.length; i += step) {
    const f = timeline[i];
    // Convert from center-based to top-left for zoompan
    const viewW = sourceSize.width / f.camera.zoom;
    const viewH = sourceSize.height / f.camera.zoom;
    keyframes.push({
      n: i,
      zoom: f.camera.zoom,
      x: Math.max(0, f.camera.x - viewW / 2),
      y: Math.max(0, f.camera.y - viewH / 2),
    });
  }

  // Build zoompan expression using if/between chains
  const buildExpr = (field: "zoom" | "x" | "y") => {
    if (keyframes.length === 1) return String(keyframes[0][field]);

    const parts: string[] = [];
    for (let i = 0; i < keyframes.length - 1; i++) {
      const a = keyframes[i];
      const b = keyframes[i + 1];
      const v = a[field];
      parts.push(`if(between(on,${a.n},${b.n - 1}),${v.toFixed(2)}`);
    }
    // Last keyframe
    const last = keyframes[keyframes.length - 1];
    parts.push(String(last[field].toFixed(2)));
    // Close all ifs
    const closing = ")".repeat(keyframes.length - 1);
    return parts.join(",") + closing;
  };

  return [
    `zoompan=`,
    `z='${buildExpr("zoom")}':`,
    `x='${buildExpr("x")}':`,
    `y='${buildExpr("y")}':`,
    `d=1:s=${outputSize.width}x${outputSize.height}:fps=${fps}`,
  ].join("");
}

/**
 * Generate a crop+scale ffmpeg filter from a timeline.
 *
 * This is a dramatically faster alternative to `generateFfmpegFilter` (zoompan).
 * Instead of decoding/scaling every frame through zoompan, it uses simple crop
 * and scale filters with per-keyframe `sendcmd`-style expressions.
 *
 * The trade-off: transitions between keyframes are step-based (instant jumps)
 * rather than smooth. For agent recordings where the camera holds steady between
 * actions, this produces nearly identical output at a fraction of the encoding time.
 *
 * @param timeline   Array of timed transforms (from CameraEngine.processTimeline)
 * @param sourceSize Original recording dimensions
 * @param outputSize Desired output dimensions
 * @returns          ffmpeg -filter_complex string using crop+scale
 */
export function generateCropScaleFilter(
  timeline: TimelineFrame[],
  sourceSize: Size,
  outputSize: Size,
): string {
  if (timeline.length === 0) return "";

  const durationSec = (timeline[timeline.length - 1].t - timeline[0].t) / 1000;
  const fps = durationSec > 0 ? Math.round(timeline.length / durationSec) : 30;

  // Sample keyframes (every 10th frame to keep filter manageable)
  const step = Math.max(1, Math.floor(timeline.length / 100));
  const keyframes: Array<{ n: number; cropW: number; cropH: number; cropX: number; cropY: number }> = [];

  for (let i = 0; i < timeline.length; i += step) {
    const f = timeline[i];
    // Compute crop region from camera transform
    const cropW = Math.round(sourceSize.width / f.camera.zoom);
    const cropH = Math.round(sourceSize.height / f.camera.zoom);
    const cropX = Math.max(0, Math.round(f.camera.x - cropW / 2));
    const cropY = Math.max(0, Math.round(f.camera.y - cropH / 2));

    keyframes.push({ n: i, cropW, cropH, cropX, cropY });
  }

  // Build crop expression using if/between chains for each parameter
  const buildCropExpr = (field: "cropW" | "cropH" | "cropX" | "cropY") => {
    if (keyframes.length === 1) return String(keyframes[0][field]);

    const parts: string[] = [];
    for (let i = 0; i < keyframes.length - 1; i++) {
      const a = keyframes[i];
      const b = keyframes[i + 1];
      parts.push(`if(between(n,${a.n},${b.n - 1}),${a[field]}`);
    }
    const last = keyframes[keyframes.length - 1];
    parts.push(String(last[field]));
    const closing = ")".repeat(keyframes.length - 1);
    return parts.join(",") + closing;
  };

  // crop=w:h:x:y with expressions, then scale to output size
  return [
    `fps=${fps},`,
    `crop=`,
    `w='${buildCropExpr("cropW")}':`,
    `h='${buildCropExpr("cropH")}':`,
    `x='${buildCropExpr("cropX")}':`,
    `y='${buildCropExpr("cropY")}',`,
    `scale=${outputSize.width}:${outputSize.height}:flags=lanczos`,
  ].join("");
}
