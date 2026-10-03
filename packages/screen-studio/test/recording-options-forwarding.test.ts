/**
 * Tests that SessionManager.stop() forwards the user-configurable `background`
 * and `deviceFrame` options (accepted by the recording_start MCP schema) all the
 * way through to renderVideo — in the *shape* the renderer's VideoRenderOptions
 * contract expects (background object as-is; deviceFrame string wrapped into
 * { type: <DeviceFrameType> }).
 *
 * Before the fix, both options were dropped at the call site, so the renderer
 * silently substituted its own DEFAULT_BACKGROUND and { type: "none" } frame.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let renderVideoCalls: any[] = [];

vi.mock("../src/mcp/ffmpeg-recorder.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/mcp/ffmpeg-recorder.js")>();
  return {
    ...orig,
    detectFfmpeg: vi.fn().mockResolvedValue("6.0"),
    probeVideoDimensions: vi.fn().mockResolvedValue(null),
    FfmpegRecorder: class {
      startCapture = vi.fn().mockResolvedValue(undefined);
      stopCapture = vi.fn().mockResolvedValue("/tmp/raw-test.mp4");
      isCapturing = vi.fn().mockReturnValue(true);
      cleanup = vi.fn().mockResolvedValue(undefined);
      kill = vi.fn();
    },
  };
});

vi.mock("../src/renderer/video-renderer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/renderer/video-renderer.js")>();
  return {
    ...orig,
    renderVideo: vi.fn(async (options: any) => {
      renderVideoCalls.push(options);
      return {
        outputPath: options.outputPath,
        durationSec: 1,
        frameCount: 0,
        canvasRendered: false,
        playbackPlan: null,
      };
    }),
  };
});

vi.mock("../src/mcp/thumbnail.js", () => ({
  extractThumbnail: vi.fn().mockResolvedValue(null),
}));

import { SessionManager } from "../src/mcp/session-manager.js";
import { Compositor } from "../src/compositor/renderer.js";
import type { CompositorConfig, CameraTransform, CursorState } from "../src/types.js";

describe("background / deviceFrame forwarding", () => {
  let manager: SessionManager;

  beforeEach(() => {
    renderVideoCalls = [];
    manager = new SessionManager();
  });

  afterEach(async () => {
    await manager.shutdownAll();
  });

  it("forwards config.background (object) and config.deviceFrame (wrapped object) to renderVideo", async () => {
    const id = await manager.create({
      captureMethod: "x11grab",
      deviceFrame: "browser-chrome",
      background: { type: "gradient", colors: ["#ff0000", "#0000ff"] },
      outputPath: "/tmp/forward-test.mp4",
    });
    await manager.stop(id);

    expect(renderVideoCalls).toHaveLength(1);
    const opts = renderVideoCalls[0];
    expect(opts.background).toEqual({ type: "gradient", colors: ["#ff0000", "#0000ff"] });
    expect(opts.deviceFrame).toEqual({ type: "browser-chrome" });
  });

  it("wraps deviceFrame into an object (not a bare string)", async () => {
    // A bare string would leave `frameConfig.type` undefined in the compositor,
    // causing FRAME_PADDING to fall back to "none" (0 padding) while `hasFrame`
    // stays true — a frameless rounded rectangle instead of the chrome title bar.
    const id = await manager.create({
      captureMethod: "x11grab",
      deviceFrame: "browser-chrome",
      outputPath: "/tmp/forward-test-shape.mp4",
    });
    await manager.stop(id);

    expect(renderVideoCalls).toHaveLength(1);
    const opts = renderVideoCalls[0];
    expect(opts.deviceFrame).toBeInstanceOf(Object);
    expect(opts.deviceFrame.type).toBe("browser-chrome");
  });

  it("forwards documented defaults when neither option is provided", async () => {
    const id = await manager.create({
      captureMethod: "x11grab",
      outputPath: "/tmp/forward-test-defaults.mp4",
    });
    await manager.stop(id);

    expect(renderVideoCalls).toHaveLength(1);
    const opts = renderVideoCalls[0];
    // resolveConfig defaults: deviceFrame "none", background gradient #0f0f23 → #1a1a3e.
    // These must be forwarded so the renderer honors resolveConfig's defaults rather
    // than its own DEFAULT_BACKGROUND (solid #0f0f23).
    expect(opts.deviceFrame).toEqual({ type: "none" });
    expect(opts.background).toEqual({
      type: "gradient",
      colors: ["#0f0f23", "#1a1a3e"],
    });
  });
});

/**
 * Compositor-level guard: proves the wrapped DeviceFrameConfig object (the shape
 * SessionManager.stop now forwards) insets the content area — whereas a bare
 * string (the naive `deviceFrame: config.deviceFrame` fix) would leave
 * `frameConfig.type` undefined and fall back to "none" padding.
 * Guards against a regression to the naive single-line fix.
 */
describe("deviceFrame shape is honored by the compositor", () => {
  const baseCursor: CursorState = {
    x: 960,
    y: 540,
    clicking: false,
    clickAge: 0,
    visible: false,
    vx: 0,
    vy: 0,
  };

  const baseCamera: CameraTransform = { x: 960, y: 540, zoom: 1 };

  function makeCompositor(deviceFrame: { type: string }): Compositor {
    const config: CompositorConfig = {
      source: { width: 1920, height: 1080 },
      output: { width: 1920, height: 1080 },
      deviceFrame: deviceFrame as any,
      background: { type: "gradient", colors: ["#ff0000", "#0000ff"] },
      cursor: {
        visible: false,
        size: 24,
        showClickRipple: false,
        rippleDuration: 0,
        showSpotlight: false,
        spotlightRadius: 0,
        spotlightColor: "",
        dualRipple: false,
      },
    };
    return new Compositor(config);
  }

  it("wrapped { type: 'browser-chrome' } insets content (dy > 0, dx > 0, titleBarHeight 40)", () => {
    const comp = makeCompositor({ type: "browser-chrome" });
    const instr = comp.computeFrame(baseCamera, baseCursor);

    expect(instr.content.dy).toBe(80); // FRAME_MARGIN (40) + titleBarHeight (40)
    expect(instr.content.dx).toBe(40); // FRAME_MARGIN
    expect(instr.deviceFrame).not.toBeNull();
    expect(instr.deviceFrame!.titleBarHeight).toBe(40);
  });

  it("{ type: 'none' } produces no inset and no device frame info", () => {
    const comp = makeCompositor({ type: "none" });
    const instr = comp.computeFrame(baseCamera, baseCursor);

    expect(instr.content.dy).toBe(0);
    expect(instr.content.dx).toBe(0);
    expect(instr.deviceFrame).toBeNull();
  });
});
