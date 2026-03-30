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
 *   Pass 2: raw.mp4 → zoompan/crop filter → final.mp4 (FfmpegRecorder.postProcess)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

const DEFAULT_STREAM_FPS = 10;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// StreamRecorder — receive WebSocket frames and pipe to ffmpeg
// ---------------------------------------------------------------------------

export interface StreamRecorderConfig {
  outputPath: string;
  fps?: number;
}

/**
 * Stream-based recorder that connects to agent-browser's WebSocket stream
 * server and pipes received JPEG frames directly to ffmpeg.
 *
 * Simpler than CdpRecorder — no CDP commands, just WebSocket frame messages.
 * The stream server handles screencasting lifecycle automatically.
 */
export class StreamRecorder {
  private ws: WebSocket | null = null;
  private ffmpeg: ChildProcess | null = null;
  private frameCount = 0;
  private active = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number = 0;
  private outputPath: string;
  private lastStderr = "";
  private fps: number;

  constructor(config: StreamRecorderConfig) {
    this.outputPath = config.outputPath;
    this.fps = config.fps ?? DEFAULT_STREAM_FPS;
  }

  /**
   * Start capturing: connect to WebSocket stream, spawn ffmpeg, begin piping.
   */
  async start(port: number): Promise<void> {
    this.port = port;
    this.active = true;

    // 1. Spawn ffmpeg with piped stdin (same pattern as CdpRecorder)
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
      // Input: MJPEG stream from pipe
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-framerate",
      String(this.fps),
      "-i",
      "pipe:0",
      // Pad to even dimensions (required for yuv420p)
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      // Encode
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
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
      // Keep only last 2KB
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
    await this.connectWebSocket();

    console.error(
      `[stream-recorder] Started, stream port ${port}, ${this.fps}fps -> ${this.outputPath}`
    );
  }

  /**
   * Stop capturing and wait for ffmpeg to finish encoding.
   * Returns the output path if frames were captured, null otherwise.
   */
  async stop(): Promise<string | null> {
    this.active = false;

    // Clear any pending reconnect
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

    console.error(`[stream-recorder] Stopped, ${this.frameCount} frames captured`);

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

  get stderr(): string {
    return this.lastStderr;
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

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.onmessage = (event: MessageEvent) => {
      if (!this.active || !this.ffmpeg?.stdin?.writable) return;

      try {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        const msg = JSON.parse(raw);

        if (msg.type === "frame" && msg.data) {
          const bytes = Buffer.from(msg.data, "base64");
          const ok = this.ffmpeg.stdin.write(bytes);
          if (!ok) {
            // Backpressure — ffmpeg can't keep up, frame will be dropped
            // (drain handling is async and we don't want to block the WS message loop)
          }
          this.frameCount++;
        }
        // "status" messages are informational — log but don't act on them
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
          // Exponential backoff capped at 5s
          this.scheduleReconnect(attempt + 1);
        }
      },
      Math.min(RECONNECT_DELAY_MS * attempt, 5_000)
    );
  }
}
