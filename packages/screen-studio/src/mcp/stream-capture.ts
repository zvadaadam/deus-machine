/**
 * Stream Frame Capture — connects to agent-browser's WebSocket stream server
 * and pipes received JPEG frames directly to ffmpeg.
 *
 * agent-browser broadcasts live JPEG frames over WebSocket. Each connected
 * client receives a continuous stream of base64-encoded JPEG frames. The
 * stream auto-starts when clients connect and auto-stops on disconnect.
 *
 * Protocol:
 *   { type: "frame", data: "<base64-jpeg>", metadata: { deviceWidth, deviceHeight, ... } }
 *   { type: "status", connected: boolean, screencasting: boolean, ... }
 *
 * Two-pass workflow:
 *   Pass 1: WebSocket frames → pipe → raw.mp4 (this module)
 *   Pass 2: raw.mp4 → canvas renderer → final.mp4 (VideoRenderer)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

const DEFAULT_STREAM_FPS = 10;
const RECONNECT_MAX_ATTEMPTS = 15;
const RECONNECT_DELAY_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
/** Interval for sending keep-alive mouse moves to trigger CDP screencast frames. */
const KEEPALIVE_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// StreamRecorder — receive WebSocket frames and pipe to ffmpeg
// ---------------------------------------------------------------------------

export interface StreamRecorderConfig {
  outputPath: string;
  fps?: number;
  /** Max time to wait for first frame in start(). Default: 15s. */
  readyTimeout?: number;
}

/**
 * Stream-based recorder that connects to agent-browser's WebSocket stream
 * server and pipes received JPEG frames directly to ffmpeg.
 *
 * Uses wallclock timestamps so raw video duration matches real session time,
 * regardless of actual frame delivery rate (~10fps from agent-browser).
 * Encodes with all I-frames for random access during post-processing.
 */
export class StreamRecorder {
  private ws: WebSocket | null = null;
  private ffmpeg: ChildProcess | null = null;
  private frameCount = 0;
  private droppedFrames = 0;
  private encoderBackpressured = false;
  private active = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timer that sends periodic mouse moves to keep CDP screencast alive. */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTick = 0;
  private port: number = 0;
  private outputPath: string;
  private lastStderr = "";
  private fps: number;
  private readyTimeout: number;
  /** Detected frame dimensions from stream metadata (set on first frame). */
  private detectedWidth: number | null = null;
  private detectedHeight: number | null = null;
  /** Timestamps for actual FPS computation. */
  private firstFrameTime: number | null = null;
  private lastFrameTime: number | null = null;
  /** Resolves when first frame arrives — used by start() to wait for readiness. */
  private readyResolve: (() => void) | null = null;

  constructor(config: StreamRecorderConfig) {
    this.outputPath = config.outputPath;
    this.fps = config.fps ?? DEFAULT_STREAM_FPS;
    this.readyTimeout = config.readyTimeout ?? FIRST_FRAME_TIMEOUT_MS;
  }

  /**
   * Start capturing: connect to WebSocket stream, spawn ffmpeg, begin piping.
   * Waits for the first frame to arrive (or readyTimeout) before returning.
   */
  async start(port: number): Promise<void> {
    this.port = port;
    this.active = true;

    // 1. Spawn ffmpeg with piped stdin — wallclock timestamps for correct duration
    const ffmpegArgs = [
      "-y",
      // Minimize probe/analysis for piped input
      "-avioflags",
      "direct",
      "-fpsprobesize",
      "0",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      // Use wall clock timestamps — raw video duration matches real time
      "-use_wallclock_as_timestamps",
      "1",
      // Input: MJPEG stream from pipe
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      // Pad to even dimensions (required for yuv420p)
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      // Encode with all I-frames for random access during post-processing
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-x264opts",
      "keyint=1:bframes=0",
      "-threads",
      "1",
      this.outputPath,
    ];

    const proc = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    this.ffmpeg = proc;

    proc.stderr?.on("data", (chunk: Buffer) => {
      this.lastStderr += chunk.toString();
      if (this.lastStderr.length > 2048) {
        this.lastStderr = this.lastStderr.slice(-2048);
      }
    });

    proc.on("error", (err: Error) => {
      console.error(`[stream-recorder] ffmpeg error: ${err.message}`);
      this.active = false;
    });

    proc.on("close", () => {
      this.ffmpeg = null;
    });

    // 2. Connect to WebSocket stream
    try {
      await this.connectWebSocket();
    } catch {
      console.error(`[stream-recorder] Stream not available yet on port ${port}, will retry`);
      this.scheduleReconnect();
    }

    // 3. Wait for first frame or timeout before returning
    await new Promise<void>((resolve) => {
      if (this.frameCount > 0) {
        resolve();
        return;
      }

      this.readyResolve = () => {
        this.readyResolve = null;
        resolve();
      };

      setTimeout(() => {
        if (this.readyResolve) {
          console.error(`[stream-recorder] No frames within ${this.readyTimeout}ms, continuing`);
          const r = this.readyResolve;
          this.readyResolve = null;
          r();
        }
      }, this.readyTimeout);
    });

    console.error(
      `[stream-recorder] Started, port ${port}, ${this.frameCount} frames buffered -> ${this.outputPath}`
    );
  }

  /**
   * Stop capturing and wait for ffmpeg to finish encoding.
   * Returns the output path if frames were captured, null otherwise.
   */
  async stop(): Promise<string | null> {
    this.active = false;
    this.stopKeepalive();

    // Clear any pending ready/reconnect
    if (this.readyResolve) {
      const r = this.readyResolve;
      this.readyResolve = null;
      r();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }

    // Close ffmpeg stdin to signal EOF, then wait for it to finish
    if (this.ffmpeg) {
      await new Promise<void>((resolve) => {
        const proc = this.ffmpeg!;

        const killTimer = setTimeout(() => {
          proc.kill("SIGKILL");
        }, 10_000);

        proc.on("close", () => {
          clearTimeout(killTimer);
          this.ffmpeg = null;
          resolve();
        });

        if (proc.stdin?.writable) {
          proc.stdin.end();
        } else {
          proc.kill("SIGINT");
        }
      });
    }

    if (this.frameCount === 0) {
      console.error("[stream-recorder] No frames captured");
      return null;
    }

    console.error(
      `[stream-recorder] Stopped, ${this.frameCount} frames captured` +
        (this.droppedFrames > 0 ? `, ${this.droppedFrames} dropped` : "") +
        (this.actualFps ? `, ${this.actualFps.toFixed(1)}fps actual` : "")
    );

    // Verify output file exists and has content
    if (!existsSync(this.outputPath)) {
      throw new Error(
        `Stream recording failed: output file not found at ${this.outputPath}.\n` +
          `ffmpeg stderr: ${this.lastStderr.slice(-300)}`
      );
    }

    const { size } = await stat(this.outputPath);
    if (size === 0) {
      throw new Error(
        `Stream recording failed: output file is empty.\n` +
          `ffmpeg stderr: ${this.lastStderr.slice(-300)}`
      );
    }

    return this.outputPath;
  }

  /**
   * Force kill everything.
   */
  kill(): void {
    this.active = false;
    this.stopKeepalive();

    if (this.readyResolve) {
      const r = this.readyResolve;
      this.readyResolve = null;
      r();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }

    this.ffmpeg?.kill("SIGKILL");
    this.ffmpeg = null;
  }

  get isCapturing(): boolean {
    return this.active;
  }

  get frames(): number {
    return this.frameCount;
  }

  /** Number of frames dropped due to ffmpeg backpressure. */
  get dropped(): number {
    return this.droppedFrames;
  }

  get stderr(): string {
    return this.lastStderr;
  }

  /** Actual FPS computed from frame delivery timestamps. */
  get actualFps(): number | null {
    if (this.frameCount < 2 || !this.firstFrameTime || !this.lastFrameTime) return null;
    const durationSec = (this.lastFrameTime - this.firstFrameTime) / 1000;
    if (durationSec <= 0) return null;
    return (this.frameCount - 1) / durationSec;
  }

  /** Returns the actual frame dimensions detected from stream metadata, or null if unknown. */
  get detectedFrameSize(): { width: number; height: number } | null {
    if (this.detectedWidth !== null && this.detectedHeight !== null) {
      return { width: this.detectedWidth, height: this.detectedHeight };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  private async connectWebSocket(): Promise<void> {
    const url = `ws://127.0.0.1:${this.port}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Stream connect timeout: ${url}`));
      }, 5_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.setupMessageHandler();
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Stream WebSocket error: ${url}`));
      };
    });
  }

  /**
   * Start sending periodic mouse-move events on the WebSocket.
   * CDP's Page.screencastFrame is event-driven — it only sends frames when
   * the page visually changes. Without this, a static page produces 0 frames.
   * Tiny 1px mouse moves are enough to trigger new screencast frames (~10fps).
   */
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTick = 0;
    this.keepaliveTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.keepaliveTick++;
      try {
        this.ws.send(
          JSON.stringify({
            type: "input_mouse",
            eventType: "mouseMoved",
            x: 10 + (this.keepaliveTick % 2),
            y: 10,
            button: "none",
            clickCount: 0,
          })
        );
      } catch {
        // WebSocket may have closed between the check and send
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    // Start keepalive to ensure continuous frame delivery
    this.startKeepalive();

    this.ws.onmessage = (event: MessageEvent) => {
      if (!this.active || !this.ffmpeg?.stdin?.writable) return;

      try {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        const msg = JSON.parse(raw);

        if (msg.type === "frame" && msg.data) {
          // Capture frame dimensions from metadata (first frame sets it)
          if (this.detectedWidth === null && msg.metadata) {
            const w = msg.metadata.deviceWidth;
            const h = msg.metadata.deviceHeight;
            if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
              this.detectedWidth = w;
              this.detectedHeight = h;
              console.error(`[stream-recorder] Detected frame size: ${w}x${h}`);
            }
          }

          // Skip frame if encoder can't keep up (backpressure)
          if (this.encoderBackpressured) {
            this.droppedFrames++;
            return;
          }

          const bytes = Buffer.from(msg.data, "base64");
          const ok = this.ffmpeg.stdin.write(bytes);
          // write() returning false means the chunk WAS buffered, not lost.
          // Count it as delivered, but pause sending until drain.
          this.frameCount++;
          const now = Date.now();
          if (this.firstFrameTime === null) this.firstFrameTime = now;
          this.lastFrameTime = now;

          // Resolve ready promise on first frame
          if (this.frameCount === 1 && this.readyResolve) {
            const r = this.readyResolve;
            this.readyResolve = null;
            r();
          }

          if (!ok) {
            this.encoderBackpressured = true;
            this.ffmpeg.stdin.once("drain", () => {
              this.encoderBackpressured = false;
            });
          }
        }
        if (msg.type === "status") {
          console.error(
            `[stream-recorder] Status: connected=${msg.connected}, screencasting=${msg.screencasting}`
          );
        }
      } catch {
        // Malformed message — skip
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.active) {
        console.error("[stream-recorder] WebSocket disconnected, attempting reconnect");
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, reconnect handled there
    };
  }

  private scheduleReconnect(attempt = 1): void {
    if (!this.active || this.reconnecting || attempt > RECONNECT_MAX_ATTEMPTS) {
      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        console.error(
          `[stream-recorder] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) exceeded, capture paused`
        );
      }
      return;
    }

    this.reconnecting = true;
    this.reconnectTimer = setTimeout(
      async () => {
        this.reconnectTimer = null;
        if (!this.active) {
          this.reconnecting = false;
          return;
        }

        try {
          await this.connectWebSocket();
          console.error(`[stream-recorder] Reconnected (attempt ${attempt})`);
          this.reconnecting = false;
        } catch {
          this.reconnecting = false;
          this.scheduleReconnect(attempt + 1);
        }
      },
      Math.min(RECONNECT_DELAY_MS * attempt, 5_000)
    );
  }
}
