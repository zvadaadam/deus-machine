import { describe, it, expect } from "vitest";
import { buildCaptureArgs } from "../src/mcp/ffmpeg-recorder.js";

describe("buildCaptureArgs", () => {
  it("builds x11grab capture args", () => {
    const args = buildCaptureArgs({
      method: "x11grab",
      sourceSize: { width: 1920, height: 1080 },
      fps: 30,
      display: ":99",
      outputPath: "/tmp/raw-test.mp4",
    });

    expect(args).toContain("-f");
    expect(args).toContain("x11grab");
    expect(args).toContain("-video_size");
    expect(args).toContain("1920x1080");
    expect(args).toContain("-framerate");
    expect(args).toContain("30");
    expect(args).toContain("-i");
    expect(args).toContain(":99");
    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("-preset");
    expect(args).toContain("ultrafast");
    expect(args).toContain("-crf");
    expect(args).toContain("18");
    expect(args[args.length - 1]).toBe("/tmp/raw-test.mp4");
    expect(args[0]).toBe("-y");
  });

  it("builds avfoundation capture args with auto-detect fallback", () => {
    const args = buildCaptureArgs({
      method: "avfoundation",
      sourceSize: { width: 1920, height: 1080 },
      fps: 30,
      display: ":99", // ignored for avfoundation
      outputPath: "/tmp/raw-test.mp4",
    });

    expect(args).toContain("-f");
    expect(args).toContain("avfoundation");
    expect(args).toContain("-framerate");
    expect(args).toContain("30");
    expect(args).toContain("-capture_cursor");
    expect(args).toContain("1");
    expect(args).toContain("-i");
    // Should have "N:none" format (N = device index)
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toMatch(/^\d+:none$/);
    // Should NOT have x11grab-specific args
    expect(args).not.toContain("-video_size");
    expect(args).not.toContain("x11grab");
  });

  it("uses explicit screenDevice when provided", () => {
    const args = buildCaptureArgs({
      method: "avfoundation",
      sourceSize: { width: 1920, height: 1080 },
      fps: 30,
      display: ":99",
      outputPath: "/tmp/raw-test.mp4",
      screenDevice: "7",
    });

    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe("7:none");
  });

  it("uses custom fps and resolution", () => {
    const args = buildCaptureArgs({
      method: "x11grab",
      sourceSize: { width: 1280, height: 720 },
      fps: 60,
      display: ":1",
      outputPath: "/tmp/custom.mp4",
    });

    expect(args).toContain("1280x720");
    expect(args).toContain("60");
    expect(args).toContain(":1");
  });
});
