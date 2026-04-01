/**
 * Cursor rendering test — verifies that cursor movement is visually
 * reflected in the rendered output frames.
 *
 * Pipeline: create test video → define events at different positions →
 * renderVideo → extract frames → load with @napi-rs/canvas →
 * verify cursor pixels differ between frames.
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { renderVideo } from "../src/renderer/video-renderer";
import type { AgentEvent } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestVideo(
  outputPath: string,
  durationSec: number,
  fps: number,
  width: number,
  height: number
): void {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${durationSec}:size=${width}x${height}:rate=${fps}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-x264opts",
      "keyint=1:bframes=0",
      outputPath,
    ],
    { stdio: "ignore", timeout: 15_000 }
  );
}

/**
 * Extract a single frame from a video at a given timestamp as a PNG file.
 */
function extractFrame(videoPath: string, timestampSec: number, outputPath: string): void {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(timestampSec),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-f",
      "image2",
      outputPath,
    ],
    { stdio: "ignore", timeout: 10_000 }
  );
}

/**
 * Sample a rectangular region of an image and return the average
 * brightness of the R, G, B channels. Returns values in [0, 255].
 */
function sampleRegionBrightness(
  imageData: { data: Uint8ClampedArray; width: number; height: number },
  cx: number,
  cy: number,
  halfSize: number
): { r: number; g: number; b: number; brightness: number } {
  const x0 = Math.max(0, Math.floor(cx - halfSize));
  const y0 = Math.max(0, Math.floor(cy - halfSize));
  const x1 = Math.min(imageData.width - 1, Math.ceil(cx + halfSize));
  const y1 = Math.min(imageData.height - 1, Math.ceil(cy + halfSize));

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y * imageData.width + x) * 4;
      totalR += imageData.data[idx];
      totalG += imageData.data[idx + 1];
      totalB += imageData.data[idx + 2];
      count++;
    }
  }

  if (count === 0) return { r: 0, g: 0, b: 0, brightness: 0 };

  const r = totalR / count;
  const g = totalG / count;
  const b = totalB / count;
  return { r, g, b, brightness: (r + g + b) / 3 };
}

/**
 * Count "bright white" pixels (all channels > threshold) in a region.
 * The cursor arrow is drawn as white (#ffffff) so this detects its presence.
 */
function countBrightPixels(
  imageData: { data: Uint8ClampedArray; width: number; height: number },
  cx: number,
  cy: number,
  halfSize: number,
  threshold = 200
): number {
  const x0 = Math.max(0, Math.floor(cx - halfSize));
  const y0 = Math.max(0, Math.floor(cy - halfSize));
  const x1 = Math.min(imageData.width - 1, Math.ceil(cx + halfSize));
  const y1 = Math.min(imageData.height - 1, Math.ceil(cy + halfSize));

  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y * imageData.width + x) * 4;
      if (
        imageData.data[idx] > threshold &&
        imageData.data[idx + 1] > threshold &&
        imageData.data[idx + 2] > threshold
      ) {
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Cursor rendering — movement across frames", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cursor-render-test-"));
  const filesToClean: string[] = [];

  afterAll(() => {
    for (const f of filesToClean) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  });

  it("renders cursor at different positions for different events", async () => {
    // Check that @napi-rs/canvas is available — skip if not
    const { isCanvasAvailable } = await import("../src/renderer/frame-renderer");
    const canvasOk = await isCanvasAvailable();
    if (!canvasOk) {
      console.warn("Skipping cursor rendering test: @napi-rs/canvas not available");
      return;
    }

    // Source dimensions (matches the test video)
    const sourceWidth = 1156;
    const sourceHeight = 720;
    const outputWidth = 1920;
    const outputHeight = 1080;
    const fps = 10;
    const durationSec = 2;

    // 1. Create a short test video (2s, 10fps, dark background via testsrc)
    const rawPath = join(testDir, "cursor-test-raw.mp4");
    const outputPath = join(testDir, "cursor-test-output.mp4");
    filesToClean.push(rawPath, outputPath);

    createTestVideo(rawPath, durationSec, fps, sourceWidth, sourceHeight);
    expect(existsSync(rawPath)).toBe(true);

    // 2. Define events at DIFFERENT positions with enough time gap
    //    First click near top-left, second click near bottom-right.
    //    The cursor arrow tip is at (x, y) and extends ~48px down-right.
    const events: AgentEvent[] = [
      { type: "click", t: 0, x: 300, y: 200 },
      { type: "click", t: 1500, x: 800, y: 600 },
    ];

    // 3. Render the video
    const result = await renderVideo({
      rawVideoPath: rawPath,
      events,
      sourceSize: { width: sourceWidth, height: sourceHeight },
      outputSize: { width: outputWidth, height: outputHeight },
      outputPath,
      outputFps: fps,
      speedRamp: false,
      cursor: {
        visible: true,
        size: 48,
        showClickRipple: false,
        rippleDuration: 400,
        showSpotlight: false,
        spotlightRadius: 60,
        spotlightColor: "rgba(58, 150, 221, 0.12)",
        dualRipple: false,
      },
    });

    // 4. Verify the output video exists and has frames
    expect(existsSync(outputPath)).toBe(true);
    expect(result.canvasRendered).toBe(true);
    expect(result.frameCount).toBeGreaterThan(0);
    console.log(`Rendered ${result.frameCount} frames, duration ${result.durationSec.toFixed(1)}s`);

    // 5. Extract 2 frames at different timestamps
    //    Frame at t=0.2s (shortly after first click at 300,200)
    //    Frame at t=1.8s (shortly after second click at 800,600)
    const frame1Path = join(testDir, "frame-early.png");
    const frame2Path = join(testDir, "frame-late.png");
    filesToClean.push(frame1Path, frame2Path);

    extractFrame(outputPath, 0.2, frame1Path);
    extractFrame(outputPath, 1.8, frame2Path);

    expect(existsSync(frame1Path)).toBe(true);
    expect(existsSync(frame2Path)).toBe(true);

    // 6. Load frame images with @napi-rs/canvas
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadImage, createCanvas } = require("@napi-rs/canvas");

    const img1 = await loadImage(frame1Path);
    const img2 = await loadImage(frame2Path);

    // Draw images onto canvases to get pixel data
    const canvas1 = createCanvas(img1.width, img1.height);
    const ctx1 = canvas1.getContext("2d");
    ctx1.drawImage(img1, 0, 0);
    const data1 = ctx1.getImageData(0, 0, img1.width, img1.height);

    const canvas2 = createCanvas(img2.width, img2.height);
    const ctx2 = canvas2.getContext("2d");
    ctx2.drawImage(img2, 0, 0);
    const data2 = ctx2.getImageData(0, 0, img2.width, img2.height);

    // 7. Verify cursor position differs between frames.
    //
    //    The source has no device frame, so the content fills the entire
    //    output canvas. Cursor output coordinates are:
    //      outputX = (cursorSourceX / sourceWidth) * outputWidth
    //      outputY = (cursorSourceY / sourceHeight) * outputHeight
    //
    //    Event 1 cursor: ~(300/1156)*1920 ≈ 498, ~(200/720)*1080 ≈ 300
    //    Event 2 cursor: ~(800/1156)*1920 ≈ 1329, ~(600/720)*1080 ≈ 900
    //
    //    We sample a 60px region around each expected position. The frame
    //    near event 1 should have bright white cursor pixels near (498, 300)
    //    and the frame near event 2 should have them near (1329, 900).

    const cursor1X = Math.round((300 / sourceWidth) * outputWidth);
    const cursor1Y = Math.round((200 / sourceHeight) * outputHeight);
    const cursor2X = Math.round((800 / sourceWidth) * outputWidth);
    const cursor2Y = Math.round((600 / sourceHeight) * outputHeight);

    // The cursor arrow extends down-right from its tip.
    // Sample slightly below and to the right of the tip for the white fill.
    const sampleOffset = 12;
    const sampleSize = 30;

    // Frame 1: cursor should be near position 1
    const bright1AtPos1 = countBrightPixels(
      data1,
      cursor1X + sampleOffset,
      cursor1Y + sampleOffset,
      sampleSize
    );
    const bright1AtPos2 = countBrightPixels(
      data1,
      cursor2X + sampleOffset,
      cursor2Y + sampleOffset,
      sampleSize
    );

    // Frame 2: cursor should be near position 2
    const bright2AtPos1 = countBrightPixels(
      data2,
      cursor1X + sampleOffset,
      cursor1Y + sampleOffset,
      sampleSize
    );
    const bright2AtPos2 = countBrightPixels(
      data2,
      cursor2X + sampleOffset,
      cursor2Y + sampleOffset,
      sampleSize
    );

    console.log("Frame 1 — bright pixels at pos1:", bright1AtPos1, "at pos2:", bright1AtPos2);
    console.log("Frame 2 — bright pixels at pos1:", bright2AtPos1, "at pos2:", bright2AtPos2);

    // Core assertion: the cursor position must differ between the two frames.
    // At least one of these must be true:
    //   - Frame 1 has more bright pixels near pos1 than frame 2 does
    //   - Frame 2 has more bright pixels near pos2 than frame 1 does
    //
    // We also check the absolute counts to confirm the cursor is actually
    // being rendered at all.

    // Verify cursor is rendered (at least some bright pixels exist in one frame)
    const totalBright = bright1AtPos1 + bright2AtPos2;
    expect(totalBright).toBeGreaterThan(0);

    // Verify the cursor position actually changes between the two frames.
    // Use a combined metric: the sum of "correct position" bright pixels
    // should exceed the sum of "wrong position" bright pixels.
    const correctPositionScore = bright1AtPos1 + bright2AtPos2;
    const wrongPositionScore = bright1AtPos2 + bright2AtPos1;

    console.log(
      `Correct position score: ${correctPositionScore}, Wrong position score: ${wrongPositionScore}`
    );

    // The cursor should be more present at the expected position in each frame
    // than at the other position. This proves the cursor actually moved.
    expect(correctPositionScore).toBeGreaterThan(wrongPositionScore);

    // Additional structural check: sample overall brightness difference
    // between the two regions across frames to confirm they are not identical.
    const brightness1 = sampleRegionBrightness(
      data1,
      cursor1X + sampleOffset,
      cursor1Y + sampleOffset,
      sampleSize
    );
    const brightness2 = sampleRegionBrightness(
      data2,
      cursor2X + sampleOffset,
      cursor2Y + sampleOffset,
      sampleSize
    );

    console.log(`Frame 1 brightness at cursor1: ${brightness1.brightness.toFixed(1)}`);
    console.log(`Frame 2 brightness at cursor2: ${brightness2.brightness.toFixed(1)}`);
  }, 60_000);
});
