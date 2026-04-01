import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata returned after probing and decoding a video. */
export interface FrameSourceInfo {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  durationSec: number;
}

// ---------------------------------------------------------------------------
// JPEG splitter
// ---------------------------------------------------------------------------

const SOI = 0xffd8;
const EOI = 0xffd9;

/**
 * Split a concatenated stream of JPEG images (image2pipe output) into
 * individual Buffer segments. Each JPEG starts with FFD8 and ends with FFD9.
 */
export function splitJpegFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;

  for (let i = 0; i < buffer.length - 1; i++) {
    const marker = (buffer[i] << 8) | buffer[i + 1];

    if (marker === SOI && start === -1) {
      start = i;
    } else if (marker === EOI && start !== -1) {
      frames.push(buffer.subarray(start, i + 2));
      start = -1;
      i += 1;
    }
  }

  return frames;
}

// ---------------------------------------------------------------------------
// FrameSource
// ---------------------------------------------------------------------------

/**
 * Reads a raw MP4 video and provides random access to individual JPEG frames.
 *
 * Decodes all frames into memory on open() — designed for recordings under
 * 5 minutes (~600 frames at 10fps = ~30MB of JPEG data).
 *
 * Usage:
 * ```ts
 * const src = new FrameSource("/path/to/raw.mp4");
 * const info = await src.open();
 * const jpeg = src.getFrame(0);
 * src.close();
 * ```
 */
export class FrameSource {
  private readonly videoPath: string;
  private frames: Buffer[] | null = null;
  private info: FrameSourceInfo | null = null;

  constructor(videoPath: string) {
    this.videoPath = videoPath;
  }

  /**
   * Probe the video for metadata, then decode every frame as JPEG into memory.
   */
  async open(): Promise<FrameSourceInfo> {
    if (this.frames !== null) {
      throw new Error("FrameSource is already opened. Call close() first.");
    }

    // Step 1: probe with ffprobe
    const probeJson = execFileSync(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        "-select_streams",
        "v:0",
        this.videoPath,
      ],
      { encoding: "utf-8", timeout: 10_000 }
    );

    const probe = JSON.parse(probeJson);
    const stream = probe.streams?.[0];
    if (!stream) {
      throw new Error(`No video stream found in ${this.videoPath}`);
    }

    const width = Number(stream.width);
    const height = Number(stream.height);
    const fps = parseFrameRate(stream.r_frame_rate ?? stream.avg_frame_rate ?? "30/1");
    const durationSec = parseDuration(stream, probe);

    // Step 2: decode all frames to JPEG via image2pipe
    const rawJpegs = execFileSync(
      "ffmpeg",
      ["-i", this.videoPath, "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "2", "pipe:1"],
      { timeout: 60_000, maxBuffer: 512 * 1024 * 1024 }
    );

    // Step 3: split concatenated JPEG stream
    this.frames = splitJpegFrames(Buffer.from(rawJpegs));

    this.info = {
      width,
      height,
      frameCount: this.frames.length,
      fps,
      durationSec,
    };

    return this.info;
  }

  /**
   * Get a decoded JPEG frame by index.
   */
  getFrame(index: number): Buffer {
    if (this.frames === null) {
      throw new Error("FrameSource is not opened. Call open() first.");
    }
    if (index < 0 || index >= this.frames.length) {
      throw new RangeError(`Frame index ${index} out of range [0, ${this.frames.length - 1}]`);
    }
    return this.frames[index];
  }

  /** Number of decoded frames, or 0 if not yet opened. */
  get frameCount(): number {
    return this.frames?.length ?? 0;
  }

  /** Return probe info, or null if not yet opened. */
  getInfo(): FrameSourceInfo | null {
    return this.info;
  }

  /** Release all frame buffers. */
  close(): void {
    this.frames = null;
    this.info = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrameRate(rate: string): number {
  const parts = rate.split("/");
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (den !== 0) return num / den;
  }
  const n = Number(rate);
  return isNaN(n) ? 30 : n;
}

function parseDuration(stream: Record<string, unknown>, probe: Record<string, unknown>): number {
  if (stream.duration && Number(stream.duration) > 0) {
    return Number(stream.duration);
  }
  if (stream.nb_frames && stream.r_frame_rate) {
    const fps = parseFrameRate(stream.r_frame_rate as string);
    const frames = Number(stream.nb_frames);
    if (frames > 0 && fps > 0) return frames / fps;
  }
  const format = probe.format as Record<string, unknown> | undefined;
  if (format?.duration && Number(format.duration) > 0) {
    return Number(format.duration);
  }
  return 0;
}
