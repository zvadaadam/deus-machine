import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentEventType } from "../types.js";
import { CameraEngine } from "../camera/engine.js";
import { TimelineRecorder } from "../recorder/encoder.js";
import { FfmpegRecorder, detectFfmpeg, probeVideoDimensions } from "./ffmpeg-recorder.js";
import { StreamRecorder } from "./stream-capture.js";
import { mapTimelineToOutput } from "../recorder/render-plan.js";
import { extractThumbnail } from "./thumbnail.js";
import type {
  Chapter,
  RecordingResult,
  RecordingSessionState,
  RecordingStartParams,
  RecordingStatus,
  ResolvedRecordingConfig,
} from "./types.js";

/**
 * Generate a short, readable session ID.
 * Format: rec_{6 hex chars} (e.g. "rec_a1b2c3")
 */
function generateSessionId(): string {
  return `rec_${randomBytes(3).toString("hex")}`;
}

/**
 * Resolve user-provided params into a fully resolved config with defaults.
 *
 * Source size defaults to 1280x720 (agent-browser's default viewport).
 * When using stream capture, the actual frame dimensions are auto-detected
 * from the stream metadata and override this at post-processing time.
 */
function resolveConfig(params: RecordingStartParams): ResolvedRecordingConfig {
  const timestamp = Date.now();
  return {
    outputPath: params.outputPath ?? join(tmpdir(), `recording-${timestamp}.mp4`),
    sourceSize: {
      width: params.sourceWidth ?? 1280,
      height: params.sourceHeight ?? 720,
    },
    outputSize: {
      width: params.outputWidth ?? 1920,
      height: params.outputHeight ?? 1080,
    },
    fps: params.fps ?? 30,
    deviceFrame: params.deviceFrame ?? "none",
    background: params.background ?? { type: "gradient", colors: ["#0f0f23", "#1a1a3e"] },
    captureMethod: params.captureMethod ?? "none",
    display: params.display ?? ":99",
  };
}

/**
 * Internal per-session state.
 */
interface InternalSession {
  state: RecordingSessionState;
  engine: CameraEngine;
  timelineRecorder: TimelineRecorder;
  /** avfoundation / x11grab recorder (two-pass: capture then post-process) */
  ffmpegRecorder: FfmpegRecorder;
  rawCapturePath: string | null;
  /** WebSocket stream recorder (agent-browser frame stream → ffmpeg) */
  streamRecorder: StreamRecorder | null;
}

/**
 * Manages multiple concurrent recording sessions.
 *
 * Capture backends:
 *   - "stream": WebSocket stream from agent-browser, 10fps, no permission, no CDP conflicts
 *   - "avfoundation": macOS native capture, 30fps, needs Screen Recording permission
 *   - "x11grab": Linux Xvfb, 30fps
 *   - "auto": try stream (if available), then avfoundation, fall back to none
 *   - "none": events-only, no video capture
 *
 * All capture backends produce a raw MP4, which is then post-processed
 * with camera effects (zoompan/crop filter) from the timeline.
 */
export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private ffmpegAvailable: boolean | null = null;

  /**
   * Create a new recording session.
   */
  async create(params: RecordingStartParams): Promise<string> {
    const id = generateSessionId();
    const config = resolveConfig(params);

    const engine = new CameraEngine({ sourceSize: config.sourceSize });
    const timelineRecorder = new TimelineRecorder({ fps: config.fps });
    const ffmpegRecorder = new FfmpegRecorder();

    const state: RecordingSessionState = {
      id,
      status: "recording",
      config,
      events: [],
      chapters: [],
      startTime: Date.now(),
    };

    let rawCapturePath: string | null = null;
    let streamRecorder: StreamRecorder | null = null;

    // Resolve capture method
    let method = config.captureMethod;
    if (method === "auto") {
      method = await this.resolveAutoCapture();
    }

    if (method === "stream") {
      // WebSocket stream from agent-browser — no OS permission, no CDP conflicts
      const streamPort = this.resolveStreamPort();
      if (streamPort) {
        rawCapturePath = join(tmpdir(), `raw-${id}.mp4`);
        streamRecorder = new StreamRecorder({
          outputPath: rawCapturePath,
        });

        try {
          await streamRecorder.start(streamPort);
        } catch (err) {
          console.error(`[session-manager] Stream capture failed: ${err}`);
          streamRecorder = null;
          rawCapturePath = null;
          // Continue without capture — events still record
        }
      } else {
        console.error("[session-manager] No stream port found, falling back to events-only");
      }
    } else if (method === "avfoundation" || method === "x11grab") {
      // Native ffmpeg capture
      if (this.ffmpegAvailable === null) {
        this.ffmpegAvailable = (await detectFfmpeg()) !== null;
      }
      if (!this.ffmpegAvailable) {
        throw new Error("ffmpeg is not available. Install ffmpeg or use captureMethod: 'none'.");
      }

      rawCapturePath = join(tmpdir(), `raw-${id}.mp4`);

      try {
        await ffmpegRecorder.startCapture({
          method,
          sourceSize: config.sourceSize,
          fps: config.fps,
          display: config.display,
          outputPath: rawCapturePath,
        });
      } catch (err) {
        if (method === "avfoundation" && config.captureMethod === "auto") {
          // avfoundation failed (likely no Screen Recording permission).
          // Fall back to events-only.
          console.error(
            `[session-manager] avfoundation failed (grant Screen Recording permission in System Settings): ${err}`
          );
          rawCapturePath = null;
        } else {
          throw err;
        }
      }
    }

    timelineRecorder.start();

    this.sessions.set(id, {
      state,
      engine,
      timelineRecorder,
      ffmpegRecorder,
      rawCapturePath,
      streamRecorder,
    });

    return id;
  }

  /**
   * Push an agent event into a recording session.
   * Drives the camera engine's auto-zoom/pan behavior.
   */
  event(
    sessionId: string,
    type: AgentEventType,
    x: number,
    y: number,
    meta?: {
      elementRect?: { x: number; y: number; width: number; height: number };
      text?: string;
      url?: string;
      direction?: string;
    }
  ): number {
    const session = this.getSession(sessionId);
    if (session.state.status !== "recording") {
      throw new Error(`Session ${sessionId} is not recording (status: ${session.state.status})`);
    }

    const t = Date.now() - session.state.startTime;

    const eventMeta: Record<string, unknown> = {};
    if (meta?.text) eventMeta.text = meta.text;
    if (meta?.url) eventMeta.url = meta.url;
    if (meta?.direction) eventMeta.direction = meta.direction;

    const agentEvent: AgentEvent = {
      type,
      t,
      x,
      y,
      elementRect: meta?.elementRect,
      meta: eventMeta,
    };

    session.state.events.push(agentEvent);
    session.engine.pushEvent(agentEvent);
    session.engine.step(1 / session.state.config.fps);

    const camera = session.engine.getTransform();
    const cursor = session.engine.getCursorState();
    session.timelineRecorder.captureFrame(t, camera, {
      x: cursor.x,
      y: cursor.y,
      clicking: cursor.clicking,
      visible: cursor.visible,
    });

    return session.state.events.length - 1;
  }

  /**
   * Add a chapter marker to the session.
   */
  chapter(sessionId: string, title: string): { chapterIndex: number; timestamp: number } {
    const session = this.getSession(sessionId);
    if (session.state.status !== "recording") {
      throw new Error(`Session ${sessionId} is not recording (status: ${session.state.status})`);
    }

    const timestamp = Date.now() - session.state.startTime;
    const chapter: Chapter = {
      title,
      timestamp,
      eventIndex: session.state.events.length,
    };

    session.state.chapters.push(chapter);

    return {
      chapterIndex: session.state.chapters.length - 1,
      timestamp,
    };
  }

  /**
   * Stop a recording session and produce the final MP4.
   *
   * Pipeline:
   *   1. Stop capture (stream or avfoundation/x11grab)
   *   2. Generate camera timeline from recorded events
   *   3. Apply zoompan/crop filter to raw capture → final MP4
   */
  async stop(
    sessionId: string,
    options?: { addWatermark?: boolean; watermarkText?: string }
  ): Promise<RecordingResult> {
    if (options?.addWatermark) {
      throw new Error("Watermarking is not yet supported by the current renderer.");
    }

    const session = this.getSession(sessionId);
    if (session.state.status !== "recording") {
      throw new Error(`Session ${sessionId} is not recording (status: ${session.state.status})`);
    }

    session.state.status = "processing";
    session.state.endTime = Date.now();

    try {
      // Stop the event-driven timeline recorder (we'll regenerate a continuous
      // timeline below using processTimeline at the raw video's fps).
      session.timelineRecorder.stop();
      const config = session.state.config;
      const duration = (session.state.endTime! - session.state.startTime) / 1000;
      let videoProduced = false;
      let playbackPlan: import("../recorder/render-plan.js").PlaybackPlan | null = null;

      // The raw video's fps: use measured delivery rate for stream, config for native.
      const _rawFps = session.streamRecorder
        ? (session.streamRecorder.actualFps ?? 10)
        : config.fps;

      // --- Stop stream recorder ---
      let actualSourceSize = config.sourceSize;
      if (session.streamRecorder) {
        try {
          const rawPath = await session.streamRecorder.stop();
          if (rawPath) {
            session.rawCapturePath = rawPath;
          } else {
            // stop() returned null → 0 frames captured
            console.error(
              "[session-manager] Stream recorder captured 0 frames, skipping post-process"
            );
            session.rawCapturePath = null;
          }
        } catch (err) {
          console.error("[session-manager] Stream capture stop failed:", err);
          session.rawCapturePath = null;
        }

        // Warn if frame count is too low for the session duration
        const expectedMin = Math.max(1, Math.floor(duration * 5));
        if (session.streamRecorder.frames > 0 && session.streamRecorder.frames < expectedMin) {
          console.error(
            `[session-manager] Low frame count: ${session.streamRecorder.frames} frames for ${duration.toFixed(1)}s ` +
              `(expected >= ${expectedMin}, dropped: ${session.streamRecorder.dropped})`
          );
        }
      }

      // --- Stop avfoundation/x11grab recorder ---
      if (session.ffmpegRecorder.isCapturing()) {
        try {
          await session.ffmpegRecorder.stopCapture();
        } catch (err) {
          console.error("[session-manager] ffmpeg capture stop failed:", err);
          session.rawCapturePath = null;
          if (session.state.events.length === 0) throw err;
        }
      }

      // --- Detect actual raw video dimensions via ffprobe ---
      if (session.rawCapturePath) {
        const probed = await probeVideoDimensions(session.rawCapturePath);
        if (probed) {
          actualSourceSize = probed;
          console.error(`[session-manager] Probed raw video: ${probed.width}x${probed.height}`);
        } else {
          const detected = session.streamRecorder?.detectedFrameSize;
          if (detected) {
            actualSourceSize = detected;
            console.error(
              `[session-manager] ffprobe failed, using stream metadata: ${detected.width}x${detected.height}`
            );
          }
        }
      }

      // --- Post-process: canvas-based rendering with cursor, zoom, effects ---
      if (session.rawCapturePath) {
        try {
          const { renderVideo } = await import("../renderer/video-renderer.js");

          // Offset events so t=0 aligns with video start (first frame),
          // not session start. The stream may start late (WebSocket connect
          // + first frame delay), so events before the first frame get t<0.
          const videoStartOffset = session.streamRecorder?.firstFrameAt
            ? session.streamRecorder.firstFrameAt - session.state.startTime
            : 0;
          const videoEvents = session.state.events.map((e) => ({
            ...e,
            t: e.t - videoStartOffset,
          }));

          const result = await renderVideo({
            rawVideoPath: session.rawCapturePath,
            events: videoEvents,
            sourceSize: actualSourceSize,
            outputSize: config.outputSize,
            outputPath: config.outputPath,
            outputFps: Math.min(config.fps, 30),
            speedRamp: true,
          });

          videoProduced = true;
          playbackPlan = result.playbackPlan;
          console.error(
            `[session-manager] Render: ${result.frameCount} frames, ` +
              `${result.durationSec.toFixed(1)}s, canvas=${result.canvasRendered}`
          );
        } catch (err) {
          console.error(`[session-manager] Video render failed: ${err}`);
          if (err instanceof Error && err.stack) {
            console.error(`[session-manager] Stack: ${err.stack}`);
          }
        }

        // Clean up raw capture files
        await session.ffmpegRecorder.cleanup();
        if (session.rawCapturePath) {
          await unlink(session.rawCapturePath).catch(() => {});
        }
      }

      session.state.status = "done";
      if (videoProduced) {
        session.state.outputPath = config.outputPath;
      }

      // Extract first-frame thumbnail (non-blocking — empty string on failure)
      let thumbnailPath = "";
      if (videoProduced) {
        thumbnailPath = (await extractThumbnail(config.outputPath)) ?? "";
      }

      // Map events + chapters to output video timestamps.
      // Use video-offset timestamps when a playback plan exists (plan was
      // built from video-relative events, so mapping input must match).
      const videoStartOffset = session.streamRecorder?.firstFrameAt
        ? session.streamRecorder.firstFrameAt - session.state.startTime
        : 0;
      const mappingEvents = videoProduced
        ? session.state.events.map((e) => ({ ...e, t: e.t - videoStartOffset }))
        : session.state.events;
      const mappingChapters = videoProduced
        ? session.state.chapters.map((c) => ({
            ...c,
            timestamp: c.timestamp - videoStartOffset,
          }))
        : session.state.chapters;
      const mapped = mapTimelineToOutput(mappingEvents, mappingChapters, playbackPlan);

      return {
        outputPath: videoProduced ? config.outputPath : "",
        thumbnailPath,
        duration: playbackPlan ? playbackPlan.outputDurationMs / 1000 : duration,
        chapters: mapped.chapters,
        events: mapped.events,
      };
    } catch (err) {
      session.state.status = "error";
      session.state.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Get the current status of a session.
   */
  status(sessionId: string): {
    status: RecordingStatus;
    duration: number;
    eventCount: number;
    chapterCount: number;
    frameCount: number;
    droppedFrames: number;
    outputPath?: string;
  } {
    const session = this.getSession(sessionId);
    const endTime = session.state.endTime ?? Date.now();
    return {
      status: session.state.status,
      duration: (endTime - session.state.startTime) / 1000,
      eventCount: session.state.events.length,
      chapterCount: session.state.chapters.length,
      frameCount: session.streamRecorder?.frames ?? 0,
      droppedFrames: session.streamRecorder?.dropped ?? 0,
      outputPath: session.state.outputPath,
    };
  }

  /**
   * Clean up a session — remove temp files and free resources.
   */
  async cleanup(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ffmpegRecorder.kill();
    session.streamRecorder?.kill();
    await session.ffmpegRecorder.cleanup();
    if (session.rawCapturePath) {
      await unlink(session.rawCapturePath).catch(() => {});
    }
    this.sessions.delete(sessionId);
  }

  /**
   * Stop all active sessions and clean up.
   */
  async shutdownAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session && session.state.status === "recording") {
        try {
          await this.stop(id);
        } catch {
          // Best-effort during shutdown
        }
      }
      await this.cleanup(id);
    }
  }

  /**
   * Resolve "auto" capture method.
   *
   * Uses agent-browser's WebSocket stream — captures JPEG frames of the
   * browser page only (not the app UI). No OS permission, no CDP conflicts.
   * Falls back to events-only if stream port not configured.
   *
   * Stream capture is the only auto-resolved method since it doesn't
   * require screen recording permissions and doesn't conflict with CDP.
   * Other methods (avfoundation, x11grab) available via explicit captureMethod.
   */
  private async resolveAutoCapture(): Promise<"stream" | "none"> {
    const streamPort = this.resolveStreamPort();
    if (streamPort) {
      return "stream";
    }
    return "none";
  }

  /**
   * Resolve the agent-browser stream port.
   * Default: 9223. Override via AGENT_BROWSER_STREAM_PORT env var.
   */
  private resolveStreamPort(): number | null {
    // 1. Explicit env var (set by agent-browser-client.ts or manually)
    const envPort = process.env.AGENT_BROWSER_STREAM_PORT;
    if (envPort) {
      const port = parseInt(envPort, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        return port;
      }
    }

    // 2. Default port (matches STREAM_PORT in agent-browser-client.ts)
    return 9223;
  }

  private getSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
