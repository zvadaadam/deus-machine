/**
 * Video Renderer — full post-processing pipeline.
 *
 * FrameSource (decode) → CameraEngine (timeline) →
 * per-frame canvas render → ffmpeg pipe (H.264 encode) → final MP4.
 *
 * Replaces the old zoompan ffmpeg filter approach.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentEvent,
  Size,
  TimedTransform,
  BackgroundConfig,
  DeviceFrameConfig,
  CursorConfig,
} from "../types.js";
import { CameraEngine } from "../camera/engine.js";
import { FrameSource } from "./frame-source.js";
import {
  createPlaybackPlan,
  outputToSourceTime,
  type PlaybackPlan,
} from "../recorder/render-plan.js";
import {
  createFrameRenderer,
  renderFrame,
  isCanvasAvailable,
  type RenderConfig,
} from "./frame-renderer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoRenderOptions {
  rawVideoPath: string;
  events: AgentEvent[];
  sourceSize: Size;
  outputSize: Size;
  outputPath: string;
  outputFps?: number;
  speedRamp?: boolean;
  background?: BackgroundConfig;
  deviceFrame?: DeviceFrameConfig;
  cursor?: CursorConfig;
  onProgress?: (rendered: number, total: number) => void;
}

export interface VideoRenderResult {
  outputPath: string;
  durationSec: number;
  frameCount: number;
  canvasRendered: boolean;
  playbackPlan: PlaybackPlan | null;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

export async function renderVideo(options: VideoRenderOptions): Promise<VideoRenderResult> {
  const {
    rawVideoPath,
    events,
    outputSize,
    outputPath,
    outputFps = 30,
    speedRamp = false,
    onProgress,
  } = options;

  // 1. Check canvas availability
  const canvasOk = await isCanvasAvailable();
  if (!canvasOk) {
    return renderVideoFallback(options);
  }

  // 2. Decode all raw frames
  const frameSource = new FrameSource(rawVideoPath);
  let sourceInfo;
  try {
    sourceInfo = await frameSource.open();
  } catch (err) {
    throw new Error(`Failed to decode raw video: ${err instanceof Error ? err.message : err}`);
  }

  if (sourceInfo.frameCount === 0) {
    frameSource.close();
    throw new Error("Raw video has 0 frames");
  }

  const actualSourceSize: Size = {
    width: sourceInfo.width,
    height: sourceInfo.height,
  };

  console.error(
    `[video-renderer] Source: ${sourceInfo.frameCount} frames, ` +
      `${sourceInfo.width}x${sourceInfo.height}, ${sourceInfo.fps.toFixed(1)}fps, ` +
      `${sourceInfo.durationSec.toFixed(1)}s`
  );

  // 3. Generate camera timeline from events
  // Disable zoom for now — at 10fps input, zoom transitions look janky.
  // Camera still tracks cursor position for smooth panning.
  const engine = new CameraEngine({
    sourceSize: actualSourceSize,
    maxZoom: 1.0,
    minZoom: 1.0,
  });
  for (const event of events) {
    engine.pushEvent(event);
  }

  const sourceDurationMs = sourceInfo.durationSec * 1000;
  const timeline = engine.processTimeline(outputFps, sourceInfo.durationSec);

  // 4. Optionally build speed ramp plan
  let plan: PlaybackPlan | null = null;
  if (speedRamp && events.length > 0) {
    plan = createPlaybackPlan(events, sourceDurationMs);
    console.error(
      `[video-renderer] Speed ramp: ${(sourceDurationMs / 1000).toFixed(1)}s → ` +
        `${(plan.outputDurationMs / 1000).toFixed(1)}s (${plan.segments.length} segments)`
    );
  }

  // 5. Compute output duration and frame count
  const outputDurationMs = plan ? plan.outputDurationMs : sourceDurationMs;
  const totalOutputFrames = Math.ceil((outputDurationMs / 1000) * outputFps);

  // 6. Create frame renderer context
  const renderConfig: RenderConfig = {
    sourceSize: actualSourceSize,
    outputSize,
    background: options.background,
    deviceFrame: options.deviceFrame,
    cursor: options.cursor,
  };

  const rendererCtx = await createFrameRenderer(renderConfig);
  if (!rendererCtx) {
    frameSource.close();
    return renderVideoFallback(options);
  }

  // 7. Spawn ffmpeg encoder
  const ffmpeg = spawnEncoder(outputSize, outputFps, outputPath);

  // 8. Render loop
  let renderedCount = 0;
  const msPerSourceFrame = 1000 / sourceInfo.fps;
  const timelineStartT = timeline.length > 0 ? timeline[0].t : 0;

  try {
    for (let i = 0; i < totalOutputFrames; i++) {
      const outputTimeMs = (i / outputFps) * 1000;

      // Map output time → source time
      const sourceTimeMs = plan ? outputToSourceTime(outputTimeMs, plan.segments) : outputTimeMs;

      // Find source frame
      const sourceFrameIdx = Math.min(
        Math.max(0, Math.round(sourceTimeMs / msPerSourceFrame)),
        sourceInfo.frameCount - 1
      );

      // Find camera transform
      const transform = findNearestTransform(timeline, timelineStartT + sourceTimeMs);

      // Get source JPEG and render
      const sourceJpeg = frameSource.getFrame(sourceFrameIdx);
      const renderedJpeg = await renderFrame(sourceJpeg, transform, renderConfig, rendererCtx);

      // Pipe to ffmpeg with backpressure handling
      const ok = ffmpeg.stdin!.write(renderedJpeg);
      if (!ok) {
        await new Promise<void>((r) => ffmpeg.stdin!.once("drain", r));
      }

      renderedCount++;
      if (onProgress && renderedCount % 30 === 0) {
        onProgress(renderedCount, totalOutputFrames);
      }
    }
  } finally {
    frameSource.close();
  }

  // 9. Wait for ffmpeg to finish
  await closeEncoder(ffmpeg);

  console.error(
    `[video-renderer] Done: ${renderedCount} frames, ${(outputDurationMs / 1000).toFixed(1)}s`
  );

  return {
    outputPath,
    durationSec: outputDurationMs / 1000,
    frameCount: renderedCount,
    canvasRendered: true,
    playbackPlan: plan,
  };
}

// ---------------------------------------------------------------------------
// Timeline lookup
// ---------------------------------------------------------------------------

function findNearestTransform(timeline: TimedTransform[], timeMs: number): TimedTransform {
  if (timeline.length === 0) {
    return {
      t: timeMs,
      camera: { x: 640, y: 360, zoom: 1 },
      cursor: {
        x: 640,
        y: 360,
        clicking: false,
        clickAge: 0,
        visible: false,
        vx: 0,
        vy: 0,
      },
    };
  }

  if (timeMs <= timeline[0].t) return timeline[0];
  if (timeMs >= timeline[timeline.length - 1].t) return timeline[timeline.length - 1];

  // Binary search
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].t <= timeMs) lo = mid;
    else hi = mid;
  }

  return timeMs - timeline[lo].t <= timeline[hi].t - timeMs ? timeline[lo] : timeline[hi];
}

// ---------------------------------------------------------------------------
// ffmpeg encoder
// ---------------------------------------------------------------------------

function spawnEncoder(outputSize: Size, fps: number, outputPath: string): ChildProcess {
  const proc = spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-s",
      `${outputSize.width}x${outputSize.height}`,
      outputPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );

  proc.stderr?.on("data", () => {});
  proc.on("error", (err: Error) => {
    console.error(`[video-renderer] ffmpeg error: ${err.message}`);
  });

  return proc;
}

async function closeEncoder(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 30_000);

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg encoder exited with code ${code}`));
    });

    if (proc.stdin?.writable) proc.stdin.end();
    else proc.kill("SIGINT");
  });
}

// ---------------------------------------------------------------------------
// Fallback: ffmpeg-only scale (no canvas)
// ---------------------------------------------------------------------------

async function renderVideoFallback(options: VideoRenderOptions): Promise<VideoRenderResult> {
  const {
    rawVideoPath,
    events,
    outputSize,
    outputPath,
    outputFps = 30,
    speedRamp = false,
  } = options;

  // Build playback plan for speed ramping (even without canvas)
  let plan: PlaybackPlan | null = null;
  let ptsFilter = "";

  if (speedRamp && events.length > 0) {
    // Probe raw video duration via ffprobe
    const { execFileSync } = await import("node:child_process");
    let rawDurationMs = 0;
    try {
      const probe = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          rawVideoPath,
        ],
        { timeout: 10_000 }
      );
      rawDurationMs = parseFloat(probe.toString().trim()) * 1000;
    } catch {
      // If probe fails, estimate from wall-clock events
      if (events.length > 0) {
        rawDurationMs = events[events.length - 1].timestamp - events[0].timestamp + 2000;
      }
    }

    if (rawDurationMs > 0) {
      plan = createPlaybackPlan(events, rawDurationMs);
      // Compute overall speed-up ratio for setpts filter
      const ratio = plan.outputDurationMs / rawDurationMs;
      ptsFilter = `setpts=${ratio.toFixed(4)}*PTS,`;
      console.error(
        `[video-renderer] Fallback speed ramp: ${(rawDurationMs / 1000).toFixed(1)}s → ` +
          `${(plan.outputDurationMs / 1000).toFixed(1)}s (ratio: ${ratio.toFixed(3)})`
      );
    }
  }

  console.error("[video-renderer] Canvas not available, using ffmpeg scale fallback");

  return new Promise<VideoRenderResult>((resolve, reject) => {
    const vf = `${ptsFilter}scale=${outputSize.width}:${outputSize.height}:flags=lanczos`;

    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        rawVideoPath,
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(outputFps),
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    proc.stderr?.on("data", () => {});
    proc.on("error", (err) => reject(new Error(`ffmpeg fallback failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({
          outputPath,
          durationSec: plan ? plan.outputDurationMs / 1000 : 0,
          frameCount: 0,
          canvasRendered: false,
          playbackPlan: plan,
        });
      } else {
        reject(new Error(`ffmpeg fallback exited with code ${code}`));
      }
    });
  });
}
