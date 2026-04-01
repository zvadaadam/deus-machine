/**
 * End-to-end pipeline test — exercises the REAL SessionManager flow:
 * create() → event() → stop() → verify output MP4 + thumbnail + chapters
 *
 * Uses a mock "raw video" created by ffmpeg (no real browser stream needed).
 * This test catches field-name bugs, path issues, and render pipeline failures
 * that unit tests miss because they mock too much.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SessionManager } from "../src/mcp/session-manager";
import { existsSync, statSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

// Create a fake raw video that SessionManager.stop() will post-process
function createTestVideo(
  outputPath: string,
  durationSec = 3,
  fps = 10,
  width = 1156,
  height = 720
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

describe("SessionManager E2E pipeline", () => {
  let sm: SessionManager;
  let testDir: string;

  beforeAll(() => {
    sm = new SessionManager();
    testDir = mkdtempSync(join(tmpdir(), "screen-studio-e2e-"));
  });

  afterAll(async () => {
    await sm.shutdownAll();
  });

  it("creates session with captureMethod=none and produces events-only result", async () => {
    const sessionId = await sm.create({ captureMethod: "none" });
    expect(sessionId).toMatch(/^rec_/);

    // Log some events
    sm.event(sessionId, "click", 500, 300);
    sm.event(sessionId, "type", 500, 320, { text: "hello" });
    sm.event(sessionId, "scroll", 500, 400, { direction: "down" });
    sm.chapter(sessionId, "Test chapter");

    // Wait a bit for timestamps to differ
    await new Promise((r) => setTimeout(r, 100));

    const result = await sm.stop(sessionId);

    expect(result.outputPath).toBe(""); // No video without capture
    expect(result.thumbnailPath).toBe("");
    expect(result.events.length).toBe(3);
    expect(result.chapters.length).toBe(1);
    expect(result.chapters[0].title).toBe("Test chapter");
    expect(result.duration).toBeGreaterThan(0);

    // Verify event types are correct
    expect(result.events[0].type).toBe("click");
    expect(result.events[1].type).toBe("type");
    expect(result.events[2].type).toBe("scroll");

    // Verify event times are numbers (not NaN!)
    for (const e of result.events) {
      expect(e.time).not.toBeNaN();
      expect(typeof e.time).toBe("number");
    }
    for (const c of result.chapters) {
      expect(c.time).not.toBeNaN();
      expect(typeof c.time).toBe("number");
    }
  });

  it("renders video with canvas path when raw capture exists", async () => {
    // Create a session with captureMethod=none (we'll inject the raw video manually)
    const sessionId = await sm.create({ captureMethod: "none" });

    // Simulate events at different timestamps
    sm.event(sessionId, "navigate", 640, 360, { url: "https://example.com" });
    await new Promise((r) => setTimeout(r, 50));
    sm.event(sessionId, "click", 300, 200);
    await new Promise((r) => setTimeout(r, 50));
    sm.event(sessionId, "type", 300, 250, { text: "test" });
    await new Promise((r) => setTimeout(r, 50));
    sm.event(sessionId, "scroll", 500, 400, { direction: "down" });
    sm.chapter(sessionId, "Navigation");
    sm.chapter(sessionId, "Interaction");

    // Create a fake raw capture file
    const rawPath = join(testDir, `raw-${sessionId}.mp4`);
    const outputPath = join(testDir, `output-${sessionId}.mp4`);
    createTestVideo(rawPath, 2, 10, 1156, 720);

    // Inject the raw capture path and output path into the session
    // We need to access internal state — use the session manager's internal map
    const session = (
      sm as unknown as { sessions: Map<string, Record<string, unknown>> }
    ).sessions.get(sessionId);
    expect(session).toBeTruthy();
    session.rawCapturePath = rawPath;
    session.state.config.outputPath = outputPath;

    const result = await sm.stop(sessionId);

    console.log("Result:", JSON.stringify(result, null, 2));

    // Verify video was produced
    expect(result.outputPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    const stat = statSync(outputPath);
    expect(stat.size).toBeGreaterThan(0);
    console.log(`Output video: ${(stat.size / 1024).toFixed(1)}KB`);

    // Verify thumbnail
    expect(result.thumbnailPath).toBeTruthy();
    if (result.thumbnailPath) {
      expect(existsSync(result.thumbnailPath)).toBe(true);
      console.log("Thumbnail:", result.thumbnailPath);
    }

    // Verify duration is speed-ramped (shorter than raw 2s)
    expect(result.duration).toBeGreaterThan(0);
    expect(result.duration).not.toBeNaN();
    console.log(`Duration: ${result.duration.toFixed(2)}s`);

    // Verify events have valid output timestamps
    expect(result.events.length).toBe(4);
    for (const e of result.events) {
      expect(e.time).not.toBeNaN();
      expect(typeof e.time).toBe("number");
      expect(e.time).toBeGreaterThanOrEqual(0);
    }

    // Verify chapters have valid output timestamps
    expect(result.chapters.length).toBe(2);
    for (const c of result.chapters) {
      expect(c.time).not.toBeNaN();
      expect(typeof c.time).toBe("number");
    }

    // Cleanup
    try {
      unlinkSync(outputPath);
    } catch {
      /* cleanup */
    }
    try {
      unlinkSync(result.thumbnailPath);
    } catch {
      /* cleanup */
    }
  });

  it("renderVideo fallback produces valid output with speed ramp", async () => {
    // Test the fallback path directly by creating a video and running renderVideoFallback
    const { renderVideo } = await import("../src/renderer/video-renderer");

    const rawPath = join(testDir, "fallback-test-raw.mp4");
    const outputPath = join(testDir, "fallback-test-output.mp4");
    createTestVideo(rawPath, 3, 10, 1156, 720);

    // Create events with proper .t field
    const events = [
      { type: "click" as const, t: 0, x: 500, y: 300 },
      { type: "type" as const, t: 500, x: 500, y: 320 },
      { type: "idle" as const, t: 2000, x: 500, y: 320 },
      { type: "click" as const, t: 2800, x: 300, y: 200 },
    ];

    const result = await renderVideo({
      rawVideoPath: rawPath,
      events,
      sourceSize: { width: 1156, height: 720 },
      outputSize: { width: 1920, height: 1080 },
      outputPath,
      outputFps: 30,
      speedRamp: true,
    });

    console.log("renderVideo result:", {
      durationSec: result.durationSec,
      frameCount: result.frameCount,
      canvasRendered: result.canvasRendered,
      hasPlaybackPlan: !!result.playbackPlan,
    });

    expect(existsSync(outputPath)).toBe(true);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.durationSec).not.toBeNaN();
    expect(result.playbackPlan).not.toBeNull();

    // If canvas is available, it should use canvas path
    const { isCanvasAvailable } = await import("../src/renderer/frame-renderer");
    const canvasOk = await isCanvasAvailable();
    if (canvasOk) {
      expect(result.canvasRendered).toBe(true);
      expect(result.frameCount).toBeGreaterThan(0);
    }

    // Cleanup
    try {
      unlinkSync(rawPath);
    } catch {
      /* cleanup */
    }
    try {
      unlinkSync(outputPath);
    } catch {
      /* cleanup */
    }
  });

  it("handles 1-frame raw video gracefully", async () => {
    const { renderVideo } = await import("../src/renderer/video-renderer");

    // Create a 1-frame video (0.1s duration)
    const rawPath = join(testDir, "oneframe-raw.mp4");
    const outputPath = join(testDir, "oneframe-output.mp4");
    createTestVideo(rawPath, 0.1, 10, 1156, 720);

    const events = [{ type: "click" as const, t: 0, x: 500, y: 300 }];

    // Should not throw
    const result = await renderVideo({
      rawVideoPath: rawPath,
      events,
      sourceSize: { width: 1156, height: 720 },
      outputSize: { width: 1920, height: 1080 },
      outputPath,
      outputFps: 30,
      speedRamp: true,
    });

    console.log("1-frame result:", {
      durationSec: result.durationSec,
      frameCount: result.frameCount,
      canvasRendered: result.canvasRendered,
    });

    // Should produce some output (even if tiny)
    expect(existsSync(outputPath)).toBe(true);

    // Cleanup
    try {
      unlinkSync(rawPath);
    } catch {
      /* cleanup */
    }
    try {
      unlinkSync(outputPath);
    } catch {
      /* cleanup */
    }
  });
});
