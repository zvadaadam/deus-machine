import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentEventType } from "../types.js";
import { CameraEngine } from "../camera/engine.js";
import { TimelineRecorder, generateFfmpegFilter } from "../recorder/encoder.js";
import { FfmpegRecorder, detectCaptureMethod, detectFfmpeg } from "./ffmpeg-recorder.js";
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
 */
function resolveConfig(params: RecordingStartParams): ResolvedRecordingConfig {
  const timestamp = Date.now();
  return {
    outputPath: params.outputPath ?? join(tmpdir(), `recording-${timestamp}.mp4`),
    sourceSize: {
      width: params.sourceWidth ?? 1920,
      height: params.sourceHeight ?? 1080,
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
 * Internal per-session state. Holds engine, recorder, and ffmpeg instances.
 */
interface InternalSession {
  state: RecordingSessionState;
  engine: CameraEngine;
  timelineRecorder: TimelineRecorder;
  ffmpegRecorder: FfmpegRecorder;
  /** Path to raw capture file (differs from final output). */
  rawCapturePath: string | null;
}

/**
 * Manages multiple concurrent recording sessions.
 *
 * Each session gets its own CameraEngine + TimelineRecorder + FfmpegRecorder.
 * Sessions are identified by short random IDs (e.g. "rec_a1b2c3").
 *
 * Lifecycle per session:
 * 1. create() — initialize engine, optionally start ffmpeg capture
 * 2. event() — push agent events that drive camera zoom/pan
 * 3. chapter() — add chapter markers with timestamps
 * 4. stop() — stop capture, run post-processing, return MP4 path
 * 5. cleanup() — remove temp files and free resources
 */
export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private ffmpegAvailable: boolean | null = null;

  /**
   * Create a new recording session.
   * Optionally starts ffmpeg screen capture if captureMethod is not "none".
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

    // Start ffmpeg capture if requested
    if (config.captureMethod !== "none" && config.captureMethod !== "screenshot") {
      // Check ffmpeg availability
      if (this.ffmpegAvailable === null) {
        this.ffmpegAvailable = (await detectFfmpeg()) !== null;
      }
      if (!this.ffmpegAvailable) {
        throw new Error("ffmpeg is not available on the system PATH. Install ffmpeg or use captureMethod: 'none'.");
      }

      rawCapturePath = join(tmpdir(), `raw-${id}.mp4`);
      const method = config.captureMethod === "x11grab" ? "x11grab"
        : config.captureMethod === "avfoundation" ? "avfoundation"
        : detectCaptureMethod();

      await ffmpegRecorder.startCapture({
        method,
        sourceSize: config.sourceSize,
        fps: config.fps,
        display: config.display,
        outputPath: rawCapturePath,
      });
    }

    timelineRecorder.start();

    this.sessions.set(id, {
      state,
      engine,
      timelineRecorder,
      ffmpegRecorder,
      rawCapturePath,
    });

    return id;
  }

  /**
   * Push an agent event into a recording session.
   * The event drives the camera engine's auto-zoom/pan behavior.
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
    },
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

    // Step the camera to process the event (small dt to update state)
    session.engine.step(1 / session.state.config.fps);

    // Capture timeline frame
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
   * Stop a recording session.
   * 1. Stops ffmpeg capture (if running)
   * 2. Generates the zoompan filter from the timeline
   * 3. Runs ffmpeg post-processing (if raw capture exists)
   * 4. Returns the final output path + metadata
   */
  async stop(
    sessionId: string,
    options?: { addWatermark?: boolean; watermarkText?: string },
  ): Promise<RecordingResult> {
    const session = this.getSession(sessionId);
    if (session.state.status !== "recording") {
      throw new Error(`Session ${sessionId} is not recording (status: ${session.state.status})`);
    }

    session.state.status = "processing";
    session.state.endTime = Date.now();

    try {
      // Stop the timeline recorder
      const timelineFrames = session.timelineRecorder.stop();

      // Stop ffmpeg capture if running — this verifies the raw file exists
      if (session.ffmpegRecorder.isCapturing()) {
        try {
          await session.ffmpegRecorder.stopCapture();
        } catch (captureErr) {
          // Capture failed — raw file missing. Clear path so we skip post-processing.
          session.rawCapturePath = null;
          // Re-throw if no events recorded either (nothing to show for this session)
          if (session.state.events.length === 0) {
            throw captureErr;
          }
          // Otherwise continue — we can still return the event timeline
        }
      }

      const config = session.state.config;
      const duration = (session.state.endTime! - session.state.startTime) / 1000;

      // If we have a raw capture and timeline frames, run post-processing
      if (session.rawCapturePath && timelineFrames.length > 0) {
        // Generate the zoompan filter from the camera timeline
        const filterComplex = generateFfmpegFilter(
          timelineFrames,
          config.sourceSize,
          config.outputSize,
        );

        if (filterComplex) {
          await session.ffmpegRecorder.postProcess({
            inputPath: session.rawCapturePath,
            outputPath: config.outputPath,
            filterComplex,
            outputSize: config.outputSize,
            addWatermark: options?.addWatermark,
            watermarkText: options?.watermarkText,
          });

          // Clean up raw capture
          await session.ffmpegRecorder.cleanup();
        }
      }

      session.state.status = "done";
      session.state.outputPath = config.outputPath;

      return {
        outputPath: config.outputPath,
        duration,
        eventCount: session.state.events.length,
        chapterCount: session.state.chapters.length,
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
    outputPath?: string;
  } {
    const session = this.getSession(sessionId);
    const endTime = session.state.endTime ?? Date.now();
    return {
      status: session.state.status,
      duration: (endTime - session.state.startTime) / 1000,
      eventCount: session.state.events.length,
      chapterCount: session.state.chapters.length,
      outputPath: session.state.outputPath,
    };
  }

  /**
   * Clean up a session — remove temp files and free memory.
   */
  async cleanup(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ffmpegRecorder.kill();
    await session.ffmpegRecorder.cleanup();
    this.sessions.delete(sessionId);
  }

  /**
   * Stop all active sessions and clean up.
   * Call on SIGINT/SIGTERM for graceful shutdown.
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
   * Get the number of active sessions.
   */
  get activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state.status === "recording") count++;
    }
    return count;
  }

  /**
   * Get a session or throw if not found.
   */
  private getSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
