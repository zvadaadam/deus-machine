import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { buildCaptureArgs, FfmpegRecorder } from "../src/mcp/ffmpeg-recorder.js";

/* -------------------------------------------------------------------------
 * Mocks for FfmpegRecorder lifecycle tests.
 * buildCaptureArgs is a pure function, so these mocks do not affect it.
 * ----------------------------------------------------------------------- */

type MockProc = EventEmitter & {
  stdin: MockStdin;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

class MockStdin extends Writable {
  writes: Buffer[] = [];

  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk);
    callback();
  }
}

let mockProc: MockProc | undefined;
let mockStdin: MockStdin | undefined;

function createMockFfmpeg(): MockProc {
  mockStdin = new MockStdin();
  const proc = Object.assign(new EventEmitter(), {
    stdin: mockStdin,
    stderr: new EventEmitter(),
    pid: 12345,
    kill: vi.fn((_sig?: string) => {}),
  }) as MockProc;
  mockProc = proc;
  return proc;
}

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, spawn: vi.fn(() => createMockFfmpeg()) };
});

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return { ...orig, existsSync: vi.fn(() => true) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return { ...orig, stat: vi.fn().mockResolvedValue({ size: 1024 }) };
});

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

describe("FfmpegRecorder lifecycle", () => {
  let recorder: FfmpegRecorder;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProc = undefined;
    mockStdin = undefined;
    recorder = new FfmpegRecorder();
  });

  afterEach(() => {
    // Best-effort: clear any pending timers by emitting a close, then kill.
    if (mockProc && recorder.isCapturing()) {
      mockProc.emit("close", 0, null);
    }
    recorder.kill();
    mockProc = undefined;
    mockStdin = undefined;
  });

  function baseConfig() {
    return {
      method: "x11grab" as const,
      sourceSize: { width: 1280, height: 720 },
      fps: 30,
      display: ":99",
      outputPath: "/tmp/raw-test.mp4",
    };
  }

  /** Start capture and drive startup to completion by emitting "frame=" on stderr. */
  async function startCapture() {
    const p = recorder.startCapture(baseConfig());
    mockProc!.stderr.emit("data", Buffer.from("frame= 1 fps=30"));
    await p;
  }

  // =========================================================================
  // Happy path
  // =========================================================================

  it("stopCapture resolves with the raw path on a clean exit (code 0)", async () => {
    await startCapture();
    expect(recorder.isCapturing()).toBe(true);

    const stopP = recorder.stopCapture();
    // stopCapture registered its close listener & wrote "q" synchronously.
    expect(mockStdin!.writes.some((b) => b.toString().includes("q"))).toBe(true);
    mockProc!.emit("close", 0, null);

    const path = await stopP;
    expect(path).toBe("/tmp/raw-test.mp4");
    expect(recorder.isCapturing()).toBe(false);
  });

  it("writes 'q' to stdin on a writable stdin and ends it", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    expect(mockStdin!.writes.map((b) => b.toString()).join("")).toBe("q");
    mockProc!.emit("close", 0, null);
    await stopP;
  });

  it("falls back to SIGINT when stdin is not writable", async () => {
    await startCapture();
    (mockProc as unknown as { stdin: { writable: boolean } }).stdin = { writable: false };

    const stopP = recorder.stopCapture();
    expect(mockProc!.kill).toHaveBeenCalledWith("SIGINT");
    mockProc!.emit("close", 0, null);

    const path = await stopP;
    expect(path).toBe("/tmp/raw-test.mp4");
  });

  it("early-return branch returns null when capture never started", async () => {
    const path = await recorder.stopCapture();
    expect(path).toBe(null);
  });

  // =========================================================================
  // The bug: non-zero exit during the stop sequence must reject
  // =========================================================================

  it("rejects with 'Capture failed during stop' on non-zero exit during stop", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    // ffmpeg crashes during the q-driven flush (e.g. ENOSPC writing the moov atom).
    mockProc!.emit("close", 1, null);

    await expect(stopP).rejects.toThrow(/Capture failed during stop/);
    await expect(stopP).rejects.toThrow(/code 1/);
    expect(recorder.isCapturing()).toBe(false);
  });

  it("surfaces captureExitError recorded by startCapture's close listener (registration order)", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    // startCapture's close listener fires first and, on code !== 0, records the
    // error into captureExitError. stopCapture's listener must surface it.
    mockProc!.emit("close", 1, null);

    await expect(stopP).rejects.toThrow(/Capture failed during stop/);
    await expect(stopP).rejects.toThrow(/ffmpeg capture exited unexpectedly/);
  });

  it("rejects on non-zero exit with a real signal (e.g. external SIGTERM)", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    mockProc!.emit("close", null, "SIGTERM");

    await expect(stopP).rejects.toThrow(/Capture failed during stop/);
  });

  it("early-return branch throws 'Capture failed during recording' when ffmpeg crashed before stop", async () => {
    await startCapture();
    // ffmpeg dies on its own before stopCapture is called.
    mockProc!.emit("close", 1, null);
    // Let the startCapture close listener run (sets captureExitError / nulls captureProcess).
    await Promise.resolve();

    expect(recorder.isCapturing()).toBe(false);
    await expect(recorder.stopCapture()).rejects.toThrow(/Capture failed during recording/);
  });

  // =========================================================================
  // SIGKILL best-effort: the 10s timeout kill is treated as best-effort
  // =========================================================================

  it("treats SIGKILL (10s timeout kill) as best-effort and resolves with the raw path", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    // The 10s killTimer fires proc.kill("SIGKILL"); the resulting close carries
    // code === null, signal === "SIGKILL". The fix must NOT treat this as a crash.
    mockProc!.emit("close", null, "SIGKILL");

    const path = await stopP;
    expect(path).toBe("/tmp/raw-test.mp4");
    expect(recorder.isCapturing()).toBe(false);
  });

  // =========================================================================
  // Stale-state hygiene: captureExitError is cleared on both paths
  // =========================================================================

  it("clears captureExitError on a clean stop (no stale throw on the next stop)", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    mockProc!.emit("close", 0, null);
    await stopP;

    // A subsequent early-return stopCapture (captureProcess is null) must return
    // the raw path rather than throwing a stale error.
    const second = await recorder.stopCapture();
    expect(second).toBe("/tmp/raw-test.mp4");
  });

  it("clears captureExitError after surfacing a failure (no stale throw on the next stop)", async () => {
    await startCapture();

    const stopP = recorder.stopCapture();
    mockProc!.emit("close", 1, null);
    await expect(stopP).rejects.toThrow(/Capture failed during stop/);

    // captureExitError cleared, so a subsequent early-return stopCapture returns
    // the raw path rather than re-throwing the stale error.
    const second = await recorder.stopCapture();
    expect(second).toBe("/tmp/raw-test.mp4");
  });

  it("clears captureExitError after the early-return 'recording' throw (no stale throw on the next stop)", async () => {
    await startCapture();
    mockProc!.emit("close", 1, null);
    await Promise.resolve();

    await expect(recorder.stopCapture()).rejects.toThrow(/Capture failed during recording/);
    // error was cleared by the throw path
    const second = await recorder.stopCapture();
    expect(second).toBe("/tmp/raw-test.mp4");
  });

  // =========================================================================
  // startCapture failure paths
  // =========================================================================

  it("startCapture rejects when ffmpeg exits before startup completes", async () => {
    const p = recorder.startCapture(baseConfig());
    mockProc!.emit("close", 1, null);

    await expect(p).rejects.toThrow(/exited before startup completed/);
    expect(recorder.isCapturing()).toBe(false);
  });
});
