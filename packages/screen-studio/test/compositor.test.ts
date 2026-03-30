import { describe, it, expect } from "vitest";
import { Compositor } from "../src/compositor/renderer.js";
import type { CompositorConfig, CameraTransform, CursorState } from "../src/types.js";

describe("Compositor", () => {
  const baseConfig: CompositorConfig = {
    output: { width: 1920, height: 1080 },
    source: { width: 1920, height: 1080 },
    deviceFrame: {
      type: "browser-chrome",
      title: "https://example.com",
      cornerRadius: 12,
    },
    background: {
      type: "gradient",
      colors: ["#1a1a2e", "#16213e"],
    },
    cursor: {
      visible: true,
      size: 24,
      showClickRipple: true,
      rippleDuration: 400,
      showSpotlight: true,
      spotlightRadius: 40,
      spotlightColor: "rgba(58, 150, 221, 0.15)",
      dualRipple: true,
    },
  };

  const baseCursor: CursorState = {
    x: 500,
    y: 300,
    clicking: false,
    clickAge: 0,
    visible: true,
    vx: 0,
    vy: 0,
  };

  describe("computeFrame", () => {
    it("produces valid render instructions at zoom 1", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      // Source should cover the whole image at zoom 1
      expect(instructions.source.sw).toBeCloseTo(1920, 0);
      expect(instructions.source.sh).toBeCloseTo(1080, 0);

      // Output size should match config
      expect(instructions.outputSize.width).toBe(1920);
      expect(instructions.outputSize.height).toBe(1080);

      // Device frame should exist
      expect(instructions.deviceFrame).not.toBeNull();
    });

    it("source region shrinks with higher zoom", () => {
      const compositor = new Compositor(baseConfig);
      const camera1: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const camera2: CameraTransform = { x: 960, y: 540, zoom: 2 };

      const i1 = compositor.computeFrame(camera1, baseCursor);
      const i2 = compositor.computeFrame(camera2, baseCursor);

      expect(i2.source.sw).toBeLessThan(i1.source.sw);
      expect(i2.source.sh).toBeLessThan(i1.source.sh);
      expect(i2.source.sw).toBeCloseTo(960, 0);
      expect(i2.source.sh).toBeCloseTo(540, 0);
    });

    it("source region follows camera position", () => {
      const compositor = new Compositor(baseConfig);
      const cameraLeft: CameraTransform = { x: 200, y: 540, zoom: 2 };
      const cameraRight: CameraTransform = { x: 1700, y: 540, zoom: 2 };

      const iLeft = compositor.computeFrame(cameraLeft, baseCursor);
      const iRight = compositor.computeFrame(cameraRight, baseCursor);

      expect(iLeft.source.sx).toBeLessThan(iRight.source.sx);
    });

    it("clamps source region to bounds", () => {
      const compositor = new Compositor(baseConfig);
      // Camera at extreme edge with zoom
      const camera: CameraTransform = { x: 0, y: 0, zoom: 2 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.source.sx).toBeGreaterThanOrEqual(0);
      expect(instructions.source.sy).toBeGreaterThanOrEqual(0);
    });

    it("cursor position maps correctly to output space", () => {
      const compositor = new Compositor(baseConfig);
      // Camera centered, zoom 1
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const cursor: CursorState = {
        x: 960, y: 540, // center of source
        clicking: false, clickAge: 0, visible: true, vx: 0, vy: 0,
      };

      const instructions = compositor.computeFrame(camera, cursor);

      // Cursor should be roughly in the center of the content area
      const contentCenterX = instructions.content.dx + instructions.content.dw / 2;
      const contentCenterY = instructions.content.dy + instructions.content.dh / 2;

      expect(instructions.cursor.x).toBeCloseTo(contentCenterX, -1);
      expect(instructions.cursor.y).toBeCloseTo(contentCenterY, -1);
    });

    it("click ripple animates correctly", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };

      // Click just started
      const clicking: CursorState = {
        x: 500, y: 300, clicking: true, clickAge: 0, visible: true, vx: 0, vy: 0,
      };
      const i1 = compositor.computeFrame(camera, clicking);
      expect(i1.cursor.ripple.active).toBe(true);
      expect(i1.cursor.ripple.radius).toBe(0);
      expect(i1.cursor.ripple.opacity).toBe(1);

      // Click midway
      const midClick: CursorState = {
        x: 500, y: 300, clicking: true, clickAge: 200, visible: true, vx: 0, vy: 0,
      };
      const i2 = compositor.computeFrame(camera, midClick);
      expect(i2.cursor.ripple.active).toBe(true);
      expect(i2.cursor.ripple.radius).toBeGreaterThan(0);
      expect(i2.cursor.ripple.opacity).toBeLessThan(1);

      // Click done
      const doneClick: CursorState = {
        x: 500, y: 300, clicking: true, clickAge: 400, visible: true, vx: 0, vy: 0,
      };
      const i3 = compositor.computeFrame(camera, doneClick);
      expect(i3.cursor.ripple.opacity).toBeCloseTo(0, 1);
    });
  });

  describe("no device frame", () => {
    it("content fills entire output", () => {
      const config: CompositorConfig = {
        ...baseConfig,
        deviceFrame: { type: "none" },
      };
      const compositor = new Compositor(config);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.deviceFrame).toBeNull();
      expect(instructions.content.dx).toBe(0);
      expect(instructions.content.dy).toBe(0);
      expect(instructions.content.dw).toBe(1920);
      expect(instructions.content.dh).toBe(1080);
    });
  });

  describe("macos-window frame", () => {
    it("has smaller title bar than browser-chrome", () => {
      const browserConfig: CompositorConfig = {
        ...baseConfig,
        deviceFrame: { type: "browser-chrome" },
      };
      const macConfig: CompositorConfig = {
        ...baseConfig,
        deviceFrame: { type: "macos-window" },
      };

      const browser = new Compositor(browserConfig);
      const mac = new Compositor(macConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };

      const bInstr = browser.computeFrame(camera, baseCursor);
      const mInstr = mac.computeFrame(camera, baseCursor);

      expect(mInstr.deviceFrame!.titleBarHeight).toBeLessThan(
        bInstr.deviceFrame!.titleBarHeight,
      );
    });
  });

  describe("hidden cursor", () => {
    it("respects config cursor.visible = false", () => {
      const config: CompositorConfig = {
        ...baseConfig,
        cursor: { ...baseConfig.cursor, visible: false },
      };
      const compositor = new Compositor(config);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.visible).toBe(false);
    });

    it("respects cursor state visible = false", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const cursor: CursorState = { ...baseCursor, visible: false };
      const instructions = compositor.computeFrame(camera, cursor);

      expect(instructions.cursor.visible).toBe(false);
    });
  });

  describe("spotlight", () => {
    it("includes active spotlight when cursor is visible", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.spotlight.active).toBe(true);
      expect(instructions.cursor.spotlight.radius).toBe(40);
      expect(instructions.cursor.spotlight.color).toBe("rgba(58, 150, 221, 0.15)");
    });

    it("deactivates spotlight when cursor is hidden", () => {
      const config: CompositorConfig = {
        ...baseConfig,
        cursor: { ...baseConfig.cursor, visible: false },
      };
      const compositor = new Compositor(config);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.spotlight.active).toBe(false);
    });

    it("deactivates spotlight when config disables it", () => {
      const config: CompositorConfig = {
        ...baseConfig,
        cursor: { ...baseConfig.cursor, showSpotlight: false },
      };
      const compositor = new Compositor(config);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.spotlight.active).toBe(false);
    });
  });

  describe("cursor velocity", () => {
    it("passes velocity through to draw command", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const cursorWithVelocity: CursorState = { ...baseCursor, vx: 100, vy: -50 };
      const instructions = compositor.computeFrame(camera, cursorWithVelocity);

      // Velocity is scaled from source to output coordinates
      expect(instructions.cursor.vx).not.toBe(0);
      expect(instructions.cursor.vy).not.toBe(0);
    });

    it("zero velocity cursor reports zero draw velocity", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.vx).toBe(0);
      expect(instructions.cursor.vy).toBe(0);
    });
  });

  describe("cursor size", () => {
    it("stays constant regardless of zoom level", () => {
      const compositor = new Compositor(baseConfig);
      const camera1: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const camera2: CameraTransform = { x: 960, y: 540, zoom: 2 };
      const camera3: CameraTransform = { x: 960, y: 540, zoom: 0.5 };

      const i1 = compositor.computeFrame(camera1, baseCursor);
      const i2 = compositor.computeFrame(camera2, baseCursor);
      const i3 = compositor.computeFrame(camera3, baseCursor);

      expect(i1.cursor.size).toBe(24);
      expect(i2.cursor.size).toBe(24);
      expect(i3.cursor.size).toBe(24);
    });
  });

  describe("dualRipple flag", () => {
    it("passes dualRipple through to draw command", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.dualRipple).toBe(true);
    });

    it("respects dualRipple: false", () => {
      const config: CompositorConfig = {
        ...baseConfig,
        cursor: { ...baseConfig.cursor, dualRipple: false },
      };
      const compositor = new Compositor(config);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const instructions = compositor.computeFrame(camera, baseCursor);

      expect(instructions.cursor.dualRipple).toBe(false);
    });
  });

  describe("ripple progress", () => {
    it("includes normalized progress in ripple", () => {
      const compositor = new Compositor(baseConfig);
      const camera: CameraTransform = { x: 960, y: 540, zoom: 1 };
      const clicking: CursorState = {
        ...baseCursor, clicking: true, clickAge: 200,
      };
      const instructions = compositor.computeFrame(camera, clicking);

      // 200ms / 400ms = 0.5
      expect(instructions.cursor.ripple.progress).toBeCloseTo(0.5, 1);
    });
  });
});
