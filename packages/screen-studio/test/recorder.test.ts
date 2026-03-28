import { describe, it, expect } from "vitest";
import { TimelineRecorder, generateFfmpegFilter } from "../src/recorder/encoder.js";

describe("TimelineRecorder", () => {
  it("captures frames when recording", () => {
    const recorder = new TimelineRecorder({ fps: 30 });
    recorder.start();

    recorder.captureFrame(0, { x: 100, y: 100, zoom: 1 }, { x: 100, y: 100, clicking: false, visible: true });
    recorder.captureFrame(33, { x: 110, y: 100, zoom: 1 }, { x: 110, y: 100, clicking: false, visible: true });
    recorder.captureFrame(66, { x: 120, y: 100, zoom: 1 }, { x: 120, y: 100, clicking: false, visible: true });

    const frames = recorder.stop();
    expect(frames).toHaveLength(3);
  });

  it("ignores frames when not recording", () => {
    const recorder = new TimelineRecorder();
    recorder.captureFrame(0, { x: 100, y: 100, zoom: 1 }, { x: 100, y: 100, clicking: false, visible: true });

    recorder.start();
    const frames = recorder.stop();
    expect(frames).toHaveLength(0);
  });

  it("enforces frame rate limit", () => {
    const recorder = new TimelineRecorder({ fps: 10 }); // 100ms interval
    recorder.start();

    // Rapid frames
    for (let t = 0; t < 1000; t += 5) {
      recorder.captureFrame(t, { x: 100, y: 100, zoom: 1 }, { x: 100, y: 100, clicking: false, visible: true });
    }

    const frames = recorder.stop();
    // At 10fps over 1 second, should have ~10 frames (not 200)
    expect(frames.length).toBeLessThan(15);
    expect(frames.length).toBeGreaterThan(5);
  });

  it("reports correct duration", () => {
    const recorder = new TimelineRecorder();
    recorder.start();

    recorder.captureFrame(0, { x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, clicking: false, visible: true });
    recorder.captureFrame(1000, { x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, clicking: false, visible: true });

    expect(recorder.getDuration()).toBe(1000);
    expect(recorder.getFrameCount()).toBe(2);
  });

  it("isRecording reflects state", () => {
    const recorder = new TimelineRecorder();
    expect(recorder.isRecording()).toBe(false);

    recorder.start();
    expect(recorder.isRecording()).toBe(true);

    recorder.stop();
    expect(recorder.isRecording()).toBe(false);
  });
});

describe("generateFfmpegFilter", () => {
  it("returns empty string for empty timeline", () => {
    expect(generateFfmpegFilter([], { width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBe("");
  });

  it("generates valid zoompan filter string", () => {
    const timeline = [
      { t: 0, camera: { x: 960, y: 540, zoom: 1 }, cursor: { x: 960, y: 540, clicking: false, visible: true } },
      { t: 33, camera: { x: 900, y: 500, zoom: 1.5 }, cursor: { x: 900, y: 500, clicking: false, visible: true } },
      { t: 66, camera: { x: 800, y: 400, zoom: 2 }, cursor: { x: 800, y: 400, clicking: true, visible: true } },
    ];

    const filter = generateFfmpegFilter(
      timeline,
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    );

    expect(filter).toContain("zoompan=");
    expect(filter).toContain("1920x1080");
    expect(filter).toContain("z='");
    expect(filter).toContain("x='");
    expect(filter).toContain("y='");
  });

  it("handles single-frame timeline", () => {
    const timeline = [
      { t: 0, camera: { x: 960, y: 540, zoom: 1.5 }, cursor: { x: 960, y: 540, clicking: false, visible: true } },
    ];

    const filter = generateFfmpegFilter(
      timeline,
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
    );

    expect(filter).toContain("zoompan=");
    expect(filter).toContain("1.5");
  });
});
