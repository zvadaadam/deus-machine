import { randomBytes } from "node:crypto";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentEventType } from "../types.js";
import { CameraEngine } from "../camera/engine.js";
import { TimelineRecorder, generateFfmpegFilter } from "../recorder/encoder.js";
import { FfmpegRecorder, detectCaptureMethod, detectFfmpeg } from "./ffmpeg-recorder.js";
import { CdpRecorder } from "./cdp-capture.js";
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
 * Internal per-session state.
 */
interface InternalSession {
  state: RecordingSessionState;
  engine: CameraEngine;
  timelineRecorder: TimelineRecorder;
  /** avfoundation / x11grab recorder (two-pass: capture then post-process) */
  ffmpegRecorder: FfmpegRecorder;
  rawCapturePath: string | null;
  /** CDP pipe-to-ffmpeg recorder (produces raw MP4 directly) */
  cdpRecorder: CdpRecorder | null;
}

/**
 * Manages multiple concurrent recording sessions.
 *
 * Capture backends:
 *   - "avfoundation": macOS native capture, 30fps, needs Screen Recording permission
 *   - "cdp": CDP Page.captureScreenshot → pipe to ffmpeg, 10fps, no permission
 *   - "x11grab": Linux Xvfb, 30fps
 *   - "auto": try avfoundation first, fall back to cdp
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
    let cdpRecorder: CdpRecorder | null = null;

    // Resolve "auto" capture method
    let method = config.captureMethod;
    if (method === "auto") {
      method = await this.resolveAutoCapture();
    }

    if (method === "cdp") {
      // CDP pipe-to-ffmpeg — no OS permission, no temp files
      const cdpPort = parseInt(process.env.CDP_PORT || "19222", 10);
      rawCapturePath = join(tmpdir(), `raw-${id}.mp4`);

      cdpRecorder = new CdpRecorder({
        cdpPort,
        outputPath: rawCapturePath,
        fps: Math.min(config.fps, 15), // CDP caps at ~15fps practical
        quality: 80,
      });

      try {
        await cdpRecorder.start();
      } catch (err) {
        console.error(`[session-manager] CDP capture failed: ${err}`);
        cdpRecorder = null;
        rawCapturePath = null;
        // Continue without capture — events still record
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
      const captureMethod = method === "avfoundation" ? "avfoundation" : "x11grab";

      try {
        await ffmpegRecorder.startCapture({
          method: captureMethod,
          sourceSize: config.sourceSize,
          fps: config.fps,
          display: config.display,
          outputPath: rawCapturePath,
        });
      } catch (err) {
        // avfoundation failed (likely no permission) — try CDP fallback
        if (method === "avfoundation" && config.captureMethod === "auto") {
          console.error(`[session-manager] avfoundation failed, trying CDP fallback: ${err}`);
          rawCapturePath = join(tmpdir(), `raw-${id}.mp4`);
          const cdpPort = parseInt(process.env.CDP_PORT || "19222", 10);
          cdpRecorder = new CdpRecorder({
            cdpPort,
            outputPath: rawCapturePath,
            fps: Math.min(config.fps, 15),
            quality: 80,
          });
          try {
            await cdpRecorder.start();
          } catch {
            cdpRecorder = null;
            rawCapturePath = null;
          }
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
      cdpRecorder,
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
   *   1. Stop capture (CDP or avfoundation/x11grab)
   *   2. Generate camera timeline from recorded events
   *   3. Apply zoompan/crop filter to raw capture → final MP4
   */
  async stop(
    sessionId: string,
    options?: { addWatermark?: boolean; watermarkText?: string }
  ): Promise<RecordingResult> {
    const session = this.getSession(sessionId);
    if (session.state.status !== "recording") {
      throw new Error(`Session ${sessionId} is not recording (status: ${session.state.status})`);
    }

    session.state.status = "processing";
    session.state.endTime = Date.now();

    try {
      const timelineFrames = session.timelineRecorder.stop();
      const config = session.state.config;
      const duration = (session.state.endTime! - session.state.startTime) / 1000;
      let videoProduced = false;

      // --- Stop CDP recorder ---
      if (session.cdpRecorder) {
        try {
          const rawPath = await session.cdpRecorder.stop();
          if (rawPath) {
            session.rawCapturePath = rawPath;
          }
        } catch (err) {
          console.error("[session-manager] CDP capture stop failed:", err);
          session.rawCapturePath = null;
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

      // --- Post-process: apply camera effects to raw capture ---
      if (session.rawCapturePath && timelineFrames.length > 0) {
        if (this.ffmpegAvailable === null) {
          this.ffmpegAvailable = (await detectFfmpeg()) !== null;
        }
        if (this.ffmpegAvailable) {
          const filterComplex = generateFfmpegFilter(
            timelineFrames,
            config.sourceSize,
            config.outputSize
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
            videoProduced = true;
          }
        }

        // Clean up raw capture file
        await session.ffmpegRecorder.cleanup();
      }

      session.state.status = "done";
      if (videoProduced) {
        session.state.outputPath = config.outputPath;
      }

      return {
        outputPath: videoProduced ? config.outputPath : "",
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
   * Clean up a session — remove temp files and free resources.
   */
  async cleanup(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ffmpegRecorder.kill();
    session.cdpRecorder?.kill();
    await session.ffmpegRecorder.cleanup();
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

  get activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state.status === "recording") count++;
    }
    return count;
  }

  /**
   * Resolve "auto" capture method:
   *   macOS → try avfoundation (will fail at capture time if no permission)
   *   Linux → x11grab
   *   CDP available → cdp
   *   Otherwise → none
   */
  private async resolveAutoCapture(): Promise<"avfoundation" | "cdp" | "x11grab" | "none"> {
    if (platform() === "darwin") {
      // Try avfoundation first — if permission denied, create() handles fallback to CDP
      return "avfoundation";
    }
    if (platform() === "linux") {
      return "x11grab";
    }
    // Check if CDP is available
    const cdpPort = parseInt(process.env.CDP_PORT || "19222", 10);
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) return "cdp";
    } catch {
      /* no CDP */
    }
    return "none";
  }

  private getSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
