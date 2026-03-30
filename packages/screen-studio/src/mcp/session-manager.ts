import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentEventType } from "../types.js";
import { CameraEngine } from "../camera/engine.js";
import { TimelineRecorder, generateFfmpegFilter } from "../recorder/encoder.js";
import { FfmpegRecorder, detectFfmpeg } from "./ffmpeg-recorder.js";
import { CdpRecorder } from "./cdp-capture.js";
import { StreamRecorder } from "./stream-capture.js";
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
  /** WebSocket stream recorder (agent-browser frame stream → ffmpeg) */
  streamRecorder: StreamRecorder | null;
}

/**
 * Manages multiple concurrent recording sessions.
 *
 * Capture backends:
 *   - "avfoundation": macOS native capture, 30fps, needs Screen Recording permission
 *   - "cdp": CDP Page.captureScreenshot → pipe to ffmpeg, 10fps, no permission
 *   - "stream": WebSocket stream from agent-browser, 10fps, no permission, no CDP conflicts
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
    let cdpRecorder: CdpRecorder | null = null;
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
          fps: Math.min(config.fps, 15), // Stream caps at ~15fps practical
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
    } else if (method === "cdp") {
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
        if (method === "avfoundation" && config.captureMethod === "auto") {
          // avfoundation failed (likely no Screen Recording permission).
          // Fall back to events-only — NOT CDP, which conflicts with agent-browser.
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
      cdpRecorder,
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

      // --- Stop stream recorder ---
      if (session.streamRecorder) {
        try {
          const rawPath = await session.streamRecorder.stop();
          if (rawPath) {
            session.rawCapturePath = rawPath;
          }
        } catch (err) {
          console.error("[session-manager] Stream capture stop failed:", err);
          session.rawCapturePath = null;
        }
      }

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
    session.streamRecorder?.kill();
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
   * Resolve "auto" capture method.
   *
   * Priority:
   *   1. Stream (if agent-browser stream port is available — no permission, no CDP conflicts)
   *   2. macOS → avfoundation (30fps, native quality, needs Screen Recording permission)
   *   3. Linux → x11grab (Xvfb/X11 capture)
   *   4. Fallback → none (events-only)
   *
   * CDP is NOT used on desktop because agent-browser also uses CDP for
   * navigation — two CDP clients on the same target causes race conditions.
   * CDP capture is available via explicit captureMethod: "cdp" for
   * standalone use (cloud agents, other projects without agent-browser).
   */
  private async resolveAutoCapture(): Promise<"stream" | "avfoundation" | "x11grab" | "none"> {
    // Stream is preferred when available — no OS permission needed, no CDP conflicts
    const streamPort = this.resolveStreamPort();
    if (streamPort) {
      try {
        // Probe the stream port to verify it's actually running
        const probeResult = await this.probeStreamPort(streamPort);
        if (probeResult) {
          return "stream";
        }
      } catch {
        // Stream not available, continue to next method
      }
    }

    if (platform() === "darwin") {
      return "avfoundation";
    }
    if (platform() === "linux") {
      return "x11grab";
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

  /**
   * Legacy: discover stream port from agent-browser session metadata
   * Kept for standalone use outside of Deus where the default port
   * might not be set
   */
  private discoverStreamPortFromMetadata(): number | null {
    try {
      const homedir = process.env.HOME || process.env.USERPROFILE || "";
      const sessionsDir = join(homedir, ".agent-browser", "sessions");
      if (existsSync(sessionsDir)) {
        const entries = readdirSync(sessionsDir, { encoding: "utf-8" }) as string[];
        for (const entry of entries.reverse()) {
          const metaPath = join(sessionsDir, entry, "metadata.json");
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta.streamPort) {
                return meta.streamPort;
              }
            } catch {
              // Skip malformed metadata
            }
          }
        }
      }
    } catch {
      // Discovery failed — not critical
    }

    return null;
  }

  /**
   * Quick probe to check if a WebSocket stream server is listening on the given port.
   * Connects, waits briefly for any message, then disconnects.
   */
  private probeStreamPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 2_000);

      const ws = new WebSocket(`ws://127.0.0.1:${port}`);

      ws.onopen = () => {
        // Server is listening — that's enough to confirm
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve(false);
      };
    });
  }

  private getSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
