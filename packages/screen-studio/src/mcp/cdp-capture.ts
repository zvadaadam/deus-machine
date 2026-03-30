/**
 * CDP Frame Capture — pipes screenshots directly to ffmpeg.
 *
 * Inspired by agent-browser's recording.rs:
 *   CDP Page.captureScreenshot (interval) → base64 decode → ffmpeg stdin → MP4
 *
 * No temp files. No numbered JPEGs. Real-time streaming pipeline.
 * No OS Screen Recording permission needed — CDP captures page content
 * directly from the renderer.
 *
 * Two-pass workflow:
 *   Pass 1: CDP screenshots → pipe → raw.mp4 (this module)
 *   Pass 2: raw.mp4 → zoompan/crop filter → final.mp4 (FfmpegRecorder.postProcess)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

const DEFAULT_CAPTURE_FPS = 10;

// ---------------------------------------------------------------------------
// CDP target discovery
// ---------------------------------------------------------------------------

async function getPageTarget(cdpPort: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = (await res.json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
      url?: string;
    }>;

    // Find the VISIBLE browser tab with a real URL.
    // Skip: renderer (localhost), hidden CDP target (about:blank/data:),
    // devtools, extensions.
    const page = targets.find(
      (t) =>
        t.type === "page" &&
        t.webSocketDebuggerUrl &&
        t.url &&
        t.url.startsWith("http") &&
        !t.url.startsWith("http://localhost:") &&
        !t.url.startsWith("http://127.0.0.1:")
    );
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal CDP WebSocket client
// ---------------------------------------------------------------------------

class CdpConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("CDP connect timeout"));
      }, 5_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      };

      ws.onmessage = (event: MessageEvent) => {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        const msg = JSON.parse(raw);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("CDP WebSocket error"));
      };

      ws.onclose = () => {
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error("CDP connection closed"));
        }
        this.pending.clear();
        this.ws = null;
      };
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) throw new Error("CDP not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws !== null;
  }
}

// ---------------------------------------------------------------------------
// CdpRecorder — capture screenshots and pipe to ffmpeg
// ---------------------------------------------------------------------------

export interface CdpRecorderConfig {
  cdpPort: number;
  outputPath: string;
  fps?: number;
  quality?: number;
}

/**
 * CDP-based recorder that pipes screenshots directly to ffmpeg.
 *
 * Same pattern as agent-browser's recording.rs:
 *   setInterval → Page.captureScreenshot → base64 decode → ffmpeg stdin
 *
 * Produces a raw MP4 that can be post-processed with camera effects.
 */
export class CdpRecorder {
  private cdp: CdpConnection | null = null;
  private ffmpeg: ChildProcess | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private frameCount = 0;
  private capturing = false;
  private reconnecting = false;
  private outputPath: string;
  private lastStderr = "";

  constructor(private config: CdpRecorderConfig) {
    this.outputPath = config.outputPath;
  }

  /**
   * Start capturing: connect to CDP, spawn ffmpeg, begin screenshot loop.
   */
  async start(): Promise<void> {
    const fps = this.config.fps ?? DEFAULT_CAPTURE_FPS;
    const quality = this.config.quality ?? 80;
    const intervalMs = Math.round(1000 / fps);

    // 1. Connect to CDP (lazy — if no visible page yet, reconnect loop handles it)
    const wsUrl = await getPageTarget(this.config.cdpPort);
    if (wsUrl) {
      try {
        const cdp = new CdpConnection();
        await cdp.connect(wsUrl);
        this.cdp = cdp;
      } catch {
        console.error("[cdp-recorder] Initial CDP connect failed, will retry in capture loop");
      }
    } else {
      console.error("[cdp-recorder] No visible page yet, will connect when one appears");
    }

    // 2. Spawn ffmpeg with piped stdin (agent-browser's pattern)
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
      String(fps),
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

    proc.on("error", (err) => {
      console.error(`[cdp-recorder] ffmpeg error: ${err.message}`);
      this.stopCapture();
    });

    proc.on("close", () => {
      this.ffmpeg = null;
    });

    // 3. Start capture loop — screenshot every intervalMs
    this.capturing = true;
    let captureInFlight = false;

    this.intervalHandle = setInterval(async () => {
      // Skip if previous capture is still in flight (like MissedTickBehavior::Skip)
      if (captureInFlight || !this.capturing || this.reconnecting) return;

      // If CDP disconnected (e.g. page navigated), try reconnecting
      if (!this.cdp?.connected) {
        await this.tryReconnect();
        return;
      }

      captureInFlight = true;
      try {
        const result = (await this.cdp!.send("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          fromSurface: true,
        })) as { data: string };

        if (!result?.data || !this.ffmpeg?.stdin?.writable) {
          captureInFlight = false;
          return;
        }

        const bytes = Buffer.from(result.data, "base64");
        const ok = this.ffmpeg.stdin.write(bytes);
        if (!ok) {
          // Backpressure — wait for drain before next frame
          await new Promise<void>((resolve) => {
            this.ffmpeg?.stdin?.once("drain", resolve);
          });
        }

        this.frameCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Target closed during navigation — reconnect to the new target
        if (msg.includes("Target closed") || msg.includes("not found") || msg.includes("closed")) {
          console.error("[cdp-recorder] Target closed (navigation?), will reconnect");
          this.cdp?.close();
          this.cdp = null;
        }
        // Other errors (timeout etc.) — skip this frame
      }
      captureInFlight = false;
    }, intervalMs);

    console.error(`[cdp-recorder] Started, ${fps}fps → ${this.outputPath}`);
  }

  /**
   * Stop capturing and wait for ffmpeg to finish encoding.
   * Returns the output path if frames were captured, null otherwise.
   */
  async stop(): Promise<string | null> {
    this.stopCapture();

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

    // Close CDP connection
    this.cdp?.close();
    this.cdp = null;

    if (this.frameCount === 0) {
      console.error("[cdp-recorder] No frames captured");
      return null;
    }

    console.error(`[cdp-recorder] Stopped, ${this.frameCount} frames captured`);

    // Verify output file exists and has content
    if (!existsSync(this.outputPath)) {
      throw new Error(
        `CDP recording failed: output file not found at ${this.outputPath}.\n` +
          `ffmpeg stderr: ${this.lastStderr.slice(-300)}`
      );
    }

    const { size } = await stat(this.outputPath);
    if (size === 0) {
      throw new Error(
        `CDP recording failed: output file is empty.\n` +
          `ffmpeg stderr: ${this.lastStderr.slice(-300)}`
      );
    }

    return this.outputPath;
  }

  /**
   * Stop the capture loop without closing ffmpeg.
   */
  private stopCapture(): void {
    this.capturing = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Re-discover and reconnect to a CDP page target after navigation.
   *
   * When a page navigates, the old target closes and a new one opens.
   * We poll briefly for the new target (up to 3 attempts, 500ms apart)
   * and reconnect so capture continues seamlessly.
   */
  private async tryReconnect(): Promise<void> {
    if (this.reconnecting || !this.capturing) return;
    this.reconnecting = true;

    const maxAttempts = 3;
    const delayMs = 500;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const wsUrl = await getPageTarget(this.config.cdpPort);
        if (wsUrl) {
          const cdp = new CdpConnection();
          await cdp.connect(wsUrl);
          this.cdp = cdp;
          console.error(`[cdp-recorder] Reconnected to new target (attempt ${attempt})`);
          return;
        }
        // Wait before retrying — new target may not be available yet
        if (attempt < maxAttempts) {
          await new Promise<void>((r) => setTimeout(r, delayMs));
        }
      }
      console.error("[cdp-recorder] No page target found after navigation, capture paused");
    } catch (err) {
      console.error(`[cdp-recorder] Reconnect failed: ${err}`);
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Force kill everything.
   */
  kill(): void {
    this.stopCapture();
    this.ffmpeg?.kill("SIGKILL");
    this.ffmpeg = null;
    this.cdp?.close();
    this.cdp = null;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  get frames(): number {
    return this.frameCount;
  }

  get stderr(): string {
    return this.lastStderr;
  }
}
