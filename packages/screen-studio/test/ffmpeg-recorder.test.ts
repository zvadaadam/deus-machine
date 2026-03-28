import { describe, it, expect } from "vitest";
import {
  buildCaptureArgs,
  buildPostProcessArgs,
  detectCaptureMethod,
  escapeDrawtext,
} from "../src/mcp/ffmpeg-recorder.js";

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

describe("buildPostProcessArgs", () => {
  it("builds basic post-processing args", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1.00':x='100.00':y='200.00':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
    });

    expect(args[0]).toBe("-y");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/raw.mp4");
    expect(args).toContain("-filter_complex");
    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("-preset");
    expect(args).toContain("slow");
    expect(args).toContain("-crf");
    expect(args).toContain("22");
    expect(args).toContain("-s");
    expect(args).toContain("1920x1080");
    expect(args[args.length - 1]).toBe("/tmp/output.mp4");
  });

  it("adds watermark filter when hasDrawtext is true", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1.00':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: true,
      watermarkText: "My Recording",
      hasDrawtext: true,
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    expect(filterValue).toContain("drawtext=text='My Recording'");
    expect(filterValue).toContain("fontsize=24");
    expect(filterValue).toContain("fontcolor=white@0.5");
  });

  it("skips watermark when hasDrawtext is false", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: true,
      watermarkText: "Should not appear",
      hasDrawtext: false,
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    expect(filterValue).not.toContain("drawtext");
  });

  it("skips watermark when hasDrawtext is undefined", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: true,
      watermarkText: "Should not appear",
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    expect(filterValue).not.toContain("drawtext");
  });

  it("does not add watermark when addWatermark is false", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: false,
      watermarkText: "Should not appear",
      hasDrawtext: true,
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    expect(filterValue).not.toContain("drawtext");
  });

  it("escapes colons in watermark text", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: true,
      watermarkText: "Time: 10:30",
      hasDrawtext: true,
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    expect(filterValue).toContain("Time\\\\: 10\\\\:30");
  });

  it("escapes all ffmpeg special characters in watermark text", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: true,
      watermarkText: "100% done; [ok]=yes",
      hasDrawtext: true,
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    // Percent becomes %%, semicolons/brackets/equals get backslash-escaped
    expect(filterValue).toContain("100%%");
    expect(filterValue).toContain("\\\\;");
    expect(filterValue).toContain("\\\\[");
    expect(filterValue).toContain("\\\\]");
    expect(filterValue).toContain("\\\\=");
  });

  it("strips newlines from watermark text", () => {
    const args = buildPostProcessArgs({
      inputPath: "/tmp/raw.mp4",
      outputPath: "/tmp/output.mp4",
      filterComplex: "zoompan=z='1':x='0':y='0':d=1:s=1920x1080:fps=30",
      outputSize: { width: 1920, height: 1080 },
      addWatermark: true,
      watermarkText: "line1\nline2",
      hasDrawtext: true,
    });

    const filterIdx = args.indexOf("-filter_complex");
    const filterValue = args[filterIdx + 1];
    expect(filterValue).toContain("line1line2");
    expect(filterValue).not.toContain("\n");
  });
});

describe("escapeDrawtext", () => {
  it("escapes backslashes", () => {
    expect(escapeDrawtext("a\\b")).toBe("a\\\\\\\\b");
  });

  it("escapes single quotes", () => {
    expect(escapeDrawtext("it's")).toBe("it'\\\\''s");
  });

  it("escapes colons", () => {
    expect(escapeDrawtext("10:30")).toBe("10\\\\:30");
  });

  it("escapes percent signs", () => {
    expect(escapeDrawtext("100%")).toBe("100%%");
  });

  it("escapes semicolons", () => {
    expect(escapeDrawtext("a;b")).toBe("a\\\\;b");
  });

  it("escapes brackets", () => {
    expect(escapeDrawtext("[tag]")).toBe("\\\\[tag\\\\]");
  });

  it("escapes equals signs", () => {
    expect(escapeDrawtext("key=val")).toBe("key\\\\=val");
  });

  it("strips newlines", () => {
    expect(escapeDrawtext("a\nb")).toBe("ab");
  });

  it("returns plain text unchanged", () => {
    expect(escapeDrawtext("hello world")).toBe("hello world");
  });
});

describe("detectCaptureMethod", () => {
  it("returns 'avfoundation' on macOS or 'x11grab' on Linux", () => {
    const method = detectCaptureMethod();
    expect(["x11grab", "avfoundation"]).toContain(method);
  });
});
