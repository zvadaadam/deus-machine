import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync, existsSync } from "node:fs";
import { FrameSource, splitJpegFrames } from "../src/renderer/frame-source.js";

// ---------------------------------------------------------------------------
// Test video helpers
// ---------------------------------------------------------------------------

function createTestVideo(
  path: string,
  opts: { width?: number; height?: number; fps?: number; duration?: number } = {}
): void {
  const { width = 320, height = 240, fps = 10, duration = 3 } = opts;
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${width}x${height}:rate=${fps}:duration=${duration}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { stdio: "ignore", timeout: 15_000 }
  );
}

function cleanup(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

// ---------------------------------------------------------------------------
// splitJpegFrames — pure unit tests (no ffmpeg)
// ---------------------------------------------------------------------------

describe("splitJpegFrames", () => {
  it("splits concatenated JPEGs correctly", () => {
    // Minimal valid JPEG: FFD8 (SOI) + some bytes + FFD9 (EOI)
    const jpeg1 = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0xff, 0xd9]);
    const jpeg2 = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9]);
    const jpeg3 = Buffer.from([0xff, 0xd8, 0x05, 0xff, 0xd9]);
    const combined = Buffer.concat([jpeg1, jpeg2, jpeg3]);

    const frames = splitJpegFrames(combined);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual(jpeg1);
    expect(frames[1]).toEqual(jpeg2);
    expect(frames[2]).toEqual(jpeg3);
  });

  it("returns empty array for non-JPEG data", () => {
    const random = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(splitJpegFrames(random)).toHaveLength(0);
  });

  it("handles single JPEG", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const frames = splitJpegFrames(jpeg);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(jpeg);
  });

  it("handles empty buffer", () => {
    expect(splitJpegFrames(Buffer.alloc(0))).toHaveLength(0);
  });

  it("ignores incomplete JPEG (SOI without EOI)", () => {
    const incomplete = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03]);
    expect(splitJpegFrames(incomplete)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FrameSource — integration tests (requires ffmpeg)
// ---------------------------------------------------------------------------

describe("FrameSource", () => {
  const testVideoPath = join(tmpdir(), "frame-source-test.mp4");

  beforeAll(() => {
    createTestVideo(testVideoPath, { width: 320, height: 240, fps: 10, duration: 3 });
  });

  afterAll(() => {
    cleanup(testVideoPath);
  });

  it("opens a video and returns correct metadata", async () => {
    const src = new FrameSource(testVideoPath);
    const info = await src.open();

    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.fps).toBeCloseTo(10, 0);
    expect(info.frameCount).toBe(30);
    expect(info.durationSec).toBeCloseTo(3, 0);

    src.close();
  });

  it("extracts correct number of frames", async () => {
    const src = new FrameSource(testVideoPath);
    await src.open();

    expect(src.frameCount).toBe(30);

    src.close();
  });

  it("getFrame returns valid JPEG buffers", async () => {
    const src = new FrameSource(testVideoPath);
    await src.open();

    const frame0 = src.getFrame(0);
    const frame15 = src.getFrame(15);

    // Each frame should start with JPEG SOI marker (FFD8)
    expect(frame0[0]).toBe(0xff);
    expect(frame0[1]).toBe(0xd8);
    // and end with EOI marker (FFD9)
    expect(frame0[frame0.length - 2]).toBe(0xff);
    expect(frame0[frame0.length - 1]).toBe(0xd9);

    expect(frame15[0]).toBe(0xff);
    expect(frame15[1]).toBe(0xd8);

    // Frames should have reasonable size (> 100 bytes for a 320x240 JPEG)
    expect(frame0.length).toBeGreaterThan(100);
    expect(frame15.length).toBeGreaterThan(100);

    src.close();
  });

  it("getFrame throws RangeError for invalid index", async () => {
    const src = new FrameSource(testVideoPath);
    await src.open();

    expect(() => src.getFrame(-1)).toThrow(RangeError);
    expect(() => src.getFrame(30)).toThrow(RangeError);
    expect(() => src.getFrame(100)).toThrow(RangeError);

    src.close();
  });

  it("getFrame throws when not opened", () => {
    const src = new FrameSource(testVideoPath);
    expect(() => src.getFrame(0)).toThrow("not opened");
  });

  it("close releases frame buffers", async () => {
    const src = new FrameSource(testVideoPath);
    await src.open();
    expect(src.frameCount).toBe(30);

    src.close();
    expect(src.frameCount).toBe(0);
    expect(src.getInfo()).toBeNull();
  });

  it("open throws when already opened", async () => {
    const src = new FrameSource(testVideoPath);
    await src.open();

    await expect(src.open()).rejects.toThrow("already opened");

    src.close();
  });

  it("handles videos with different dimensions", async () => {
    const hdPath = join(tmpdir(), "frame-source-hd-test.mp4");
    try {
      createTestVideo(hdPath, { width: 1280, height: 720, fps: 10, duration: 1 });
      const src = new FrameSource(hdPath);
      const info = await src.open();

      expect(info.width).toBe(1280);
      expect(info.height).toBe(720);
      expect(info.frameCount).toBe(10);

      src.close();
    } finally {
      cleanup(hdPath);
    }
  });
});
