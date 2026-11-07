import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { ScreenStudioError } from "../errors.js";
import { ffmpegBin } from "../util/ffmpeg.js";
import { jpegSize } from "../util/jpeg.js";
import { tail } from "../util/process.js";
import { even, type Size } from "../util/units.js";

export interface FramePumpOptions {
  /** Fragmented MP4 written while recording; stays playable if the process dies. */
  outputPath: string;
  fps: number;
  log?: (message: string) => void;
  onUnexpectedExit?: (error: Error) => void;
}

/**
 * Turns a sporadic stream of JPEG frames into constant-rate video whose clock
 * is the recorder's, not the source's.
 *
 * Damage-driven sources such as a CDP screencast send nothing while the page is
 * still. Instead of provoking frames with synthetic input, the pump re-emits the
 * latest frame on every tick: frame k is on screen at start + k/fps, so media
 * time maps to wall time by construction, and stills cost almost nothing to
 * encode. Frames arriving faster than `fps` are sampled down to the latest.
 */
export class FramePump {
  private readonly options: FramePumpOptions;
  private ffmpeg: ChildProcess | null = null;
  private exit: Promise<void> | null = null;
  private latest: Buffer | null = null;
  private startEpochMs: number | null = null;
  private written = 0;
  private received = 0;
  private draining = false;
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stderr = "";
  private mediaSize: Size | null = null;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  /** Resolves when the first frame has been handed to the encoder. */
  readonly ready: Promise<void>;

  constructor(options: FramePumpOptions) {
    this.options = options;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready.catch(() => {});
  }

  get startedAtEpochMs(): number | null {
    return this.startEpochMs;
  }

  get framesWritten(): number {
    return this.written;
  }

  get framesReceived(): number {
    return this.received;
  }

  get size(): Size | null {
    return this.mediaSize;
  }

  async bytesWritten(): Promise<number> {
    try {
      return (await stat(this.options.outputPath)).size;
    } catch {
      return 0;
    }
  }

  push(jpeg: Buffer, receivedAtEpochMs = Date.now()): void {
    if (this.stopping) return;
    this.received++;
    this.latest = jpeg;
    if (!this.ffmpeg) {
      try {
        this.begin(jpeg, receivedAtEpochMs);
      } catch (err) {
        this.readyReject(err as Error);
        return;
      }
    }
    this.pump(Date.now());
  }

  private begin(first: Buffer, at: number): void {
    const decoded = jpegSize(first);
    if (!decoded) throw new ScreenStudioError("capture_failed", "First frame is not a JPEG image");
    const size = { width: even(decoded.width), height: even(decoded.height) };
    this.mediaSize = size;
    const { fps } = this.options;
    const fit =
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
      `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    const proc = spawn(
      ffmpegBin(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-vf",
        fit,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-g",
        String(fps * 2),
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "-y",
        this.options.outputPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );
    this.ffmpeg = proc;
    this.startEpochMs = at;
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    proc.stdin?.on("error", () => {
      // EPIPE after an encoder crash; reported through the exit handler.
    });
    this.exit = new Promise((resolve) => {
      proc.once("error", (err) => {
        this.readyReject(err);
        resolve();
      });
      proc.once("close", (code, signal) => {
        this.ffmpeg = null;
        if (this.timer) clearInterval(this.timer);
        if (!this.stopping) {
          const error = new ScreenStudioError(
            "capture_failed",
            `Encoder exited unexpectedly (${signal ?? `exit ${code}`}): ${tail(this.stderr)}`
          );
          this.readyReject(error);
          this.options.onUnexpectedExit?.(error);
        }
        resolve();
      });
    });
    this.timer = setInterval(() => this.pump(Date.now()), Math.max(5, 1000 / fps / 2));
    this.options.log?.(`frame pump: ${size.width}x${size.height} @ ${fps} fps`);
  }

  private due(at: number): number {
    if (this.startEpochMs === null) return 0;
    return Math.floor(((at - this.startEpochMs) * this.options.fps) / 1000) + 1;
  }

  private pump(now: number): void {
    const stdin = this.ffmpeg?.stdin;
    if (!stdin || !this.latest || this.draining) return;
    const target = this.due(now);
    while (this.written < target) {
      const ok = stdin.write(this.latest);
      this.written++;
      if (this.written === 1) this.readyResolve();
      if (!ok) {
        this.draining = true;
        stdin.once("drain", () => {
          this.draining = false;
          if (!this.stopping) this.pump(Date.now());
        });
        return;
      }
    }
  }

  /**
   * Hold the last frame until `stopAtEpochMs`, then finalize. The media then
   * covers the whole capture window even if the source went still.
   */
  async stop(stopAtEpochMs = Date.now()): Promise<{ frames: number }> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const proc = this.ffmpeg;
    if (!proc || !proc.stdin) {
      await this.exit;
      return { frames: this.written };
    }
    const stdin = proc.stdin;
    // Armed first: an encoder that stops draining must not hang stop().
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const target = this.due(stopAtEpochMs);
    while (this.written < target && this.latest && this.ffmpeg) {
      const ok = stdin.write(this.latest);
      this.written++;
      if (!ok) {
        const drained = new Promise<void>((resolve) => stdin.once("drain", resolve));
        await Promise.race([drained, this.exit]);
      }
    }
    stdin.end();
    await this.exit;
    clearTimeout(killTimer);
    return { frames: this.written };
  }

  kill(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.ffmpeg?.kill("SIGKILL");
  }

  get pid(): number | undefined {
    return this.ffmpeg?.pid;
  }
}
