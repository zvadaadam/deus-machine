import { describe, it, expect } from "vitest";
import { CameraEngine } from "../src/camera/engine.js";
import type { AgentEvent } from "../src/types.js";

describe("CameraEngine", () => {
  const sourceSize = { width: 1920, height: 1080 };

  function createEngine() {
    return new CameraEngine({ sourceSize });
  }

  describe("initialization", () => {
    it("starts at center of source with zoom 1", () => {
      const engine = createEngine();
      const t = engine.getTransform();

      expect(t.x).toBe(960);
      expect(t.y).toBe(540);
      expect(t.zoom).toBe(1);
    });

    it("accepts custom initial state", () => {
      const engine = new CameraEngine({
        sourceSize,
        initialState: { x: 100, y: 200, zoom: 2 },
      });
      const t = engine.getTransform();

      expect(t.x).toBe(100);
      expect(t.y).toBe(200);
      expect(t.zoom).toBe(2);
    });
  });

  describe("pushEvent + step", () => {
    it("moves camera toward click event", () => {
      const engine = createEngine();

      engine.pushEvent({ type: "click", x: 200, y: 200, t: 0 });

      // Step for a few seconds
      const dt = 1 / 60;
      for (let i = 0; i < 300; i++) {
        engine.step(dt);
      }

      const t = engine.getTransform();
      // Camera should have moved toward (200, 200)
      expect(t.x).toBeLessThan(960);
      expect(t.y).toBeLessThan(540);
    });

    it("zooms in for typing events", () => {
      const engine = createEngine();

      engine.pushEvent({ type: "type", x: 500, y: 300, t: 0 });
      engine.pushEvent({ type: "type", x: 510, y: 300, t: 100 });
      engine.pushEvent({ type: "type", x: 520, y: 300, t: 200 });

      const dt = 1 / 60;
      for (let i = 0; i < 300; i++) {
        engine.step(dt);
      }

      const t = engine.getTransform();
      expect(t.zoom).toBeGreaterThan(1);
    });

    it("stays at zoom 1 for idle/navigation", () => {
      const engine = createEngine();
      engine.pushEvent({ type: "navigate", x: 960, y: 540, t: 0 });

      const dt = 1 / 60;
      for (let i = 0; i < 300; i++) {
        engine.step(dt);
      }

      const t = engine.getTransform();
      expect(t.zoom).toBeLessThan(1.3);
    });
  });

  describe("step without events", () => {
    it("camera stays at initial position", () => {
      const engine = createEngine();
      const initial = engine.getTransform();

      engine.step(1 / 60);
      engine.step(1 / 60);
      engine.step(1 / 60);

      const after = engine.getTransform();
      expect(after.x).toBe(initial.x);
      expect(after.y).toBe(initial.y);
      expect(after.zoom).toBe(initial.zoom);
    });
  });

  describe("jumpTo", () => {
    it("instantly moves camera with zero velocity", () => {
      const engine = createEngine();

      // Push event to create some velocity
      engine.pushEvent({ type: "click", x: 200, y: 200, t: 0 });
      engine.step(1 / 60);

      // Jump to specific position
      engine.jumpTo({ x: 800, y: 400, zoom: 2 });

      const t = engine.getTransform();
      expect(t.x).toBe(800);
      expect(t.y).toBe(400);
      expect(t.zoom).toBe(2);

      // Velocity should be zero
      const state = engine.getState();
      expect(state.vx).toBe(0);
      expect(state.vy).toBe(0);
      expect(state.vzoom).toBe(0);
    });

    it("partial jumpTo only updates specified axes", () => {
      const engine = createEngine();
      engine.jumpTo({ x: 800 });

      const t = engine.getTransform();
      expect(t.x).toBe(800);
      expect(t.y).toBe(540); // unchanged
      expect(t.zoom).toBe(1); // unchanged
    });
  });

  describe("setTarget", () => {
    it("camera smoothly moves to manual target", () => {
      const engine = createEngine();
      engine.setTarget({ x: 200, y: 200, zoom: 2 });

      const dt = 1 / 60;
      for (let i = 0; i < 300; i++) {
        engine.step(dt);
      }

      const t = engine.getTransform();
      // Should have moved toward target (dead zone may prevent exact match)
      expect(t.zoom).toBeGreaterThan(1.5);
    });
  });

  describe("isSettled", () => {
    it("returns true when camera is at rest", () => {
      const engine = createEngine();
      expect(engine.isSettled()).toBe(true);
    });

    it("returns false during animation", () => {
      const engine = createEngine();
      engine.pushEvent({ type: "click", x: 200, y: 200, t: 0 });
      engine.step(1 / 60);

      expect(engine.isSettled()).toBe(false);
    });
  });

  describe("getCursorState", () => {
    it("sets click state and visibility from events", () => {
      const engine = createEngine();

      engine.pushEvent({ type: "click", x: 500, y: 300, t: 0 });

      const cursor = engine.getCursorState();
      // Cursor uses spring interpolation — position doesn't teleport,
      // but click state and visibility are set immediately
      expect(cursor.clicking).toBe(true);
      expect(cursor.visible).toBe(true);
    });

    it("cursor position interpolates toward event via spring", () => {
      const engine = createEngine();

      engine.pushEvent({ type: "click", x: 500, y: 300, t: 0 });

      // Before stepping, cursor is still at center (spring hasn't moved)
      const before = engine.getCursorState();
      expect(before.x).toBe(960); // center
      expect(before.y).toBe(540); // center

      // After stepping, cursor moves toward target
      const dt = 1 / 60;
      for (let i = 0; i < 120; i++) {
        engine.step(dt);
      }

      const after = engine.getCursorState();
      // Cursor should be very close to target after ~2 seconds of spring
      expect(after.x).toBeCloseTo(500, 0);
      expect(after.y).toBeCloseTo(300, 0);
    });

    it("cursor state includes velocity", () => {
      const engine = createEngine();

      engine.pushEvent({ type: "click", x: 200, y: 200, t: 0 });
      engine.step(1 / 60);

      const cursor = engine.getCursorState();
      // Cursor should have velocity while spring is active
      expect(cursor.vx).not.toBe(0);
      expect(cursor.vy).not.toBe(0);
    });

    it("click ripple expires after 400ms timeout", () => {
      const engine = createEngine();
      engine.pushEvent({ type: "click", x: 500, y: 300, t: 0 });

      // Step past click timeout (400ms = 24 frames at 60fps)
      for (let i = 0; i < 30; i++) {
        engine.step(1 / 60);
      }

      const cursor = engine.getCursorState();
      expect(cursor.clicking).toBe(false);
    });
  });

  describe("getCurrentIntent", () => {
    it("returns null before any events", () => {
      const engine = createEngine();
      expect(engine.getCurrentIntent()).toBeNull();
    });

    it("returns intent after event", () => {
      const engine = createEngine();
      engine.pushEvent({ type: "type", x: 500, y: 300, t: 0 });

      const intent = engine.getCurrentIntent();
      expect(intent).not.toBeNull();
      expect(intent!.type).toBe("typing");
    });
  });

  describe("processTimeline", () => {
    it("generates timeline from events", () => {
      const engine = createEngine();

      // Push events
      engine.pushEvent({ type: "click", x: 500, y: 300, t: 0 });
      engine.pushEvent({ type: "type", x: 500, y: 300, t: 500 });
      engine.pushEvent({ type: "type", x: 520, y: 300, t: 1000 });
      engine.pushEvent({ type: "scroll", x: 520, y: 500, t: 3000 });

      const timeline = engine.processTimeline(30);

      expect(timeline.length).toBeGreaterThan(0);

      // First frame should be near starting position
      expect(timeline[0].camera.zoom).toBeCloseTo(1, 0);

      // Timeline should have consistent time spacing
      for (let i = 1; i < Math.min(timeline.length, 10); i++) {
        const dt = timeline[i].t - timeline[i - 1].t;
        expect(dt).toBeCloseTo(1000 / 30, 1); // ~33ms per frame
      }
    });

    it("handles empty event buffer", () => {
      const engine = new CameraEngine({ sourceSize });
      const timeline = engine.processTimeline();
      expect(timeline).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("returns engine to initial state", () => {
      const engine = createEngine();

      engine.pushEvent({ type: "click", x: 200, y: 200, t: 0 });
      for (let i = 0; i < 60; i++) engine.step(1 / 60);

      engine.reset();

      const t = engine.getTransform();
      expect(t.x).toBe(960);
      expect(t.y).toBe(540);
      expect(t.zoom).toBe(1);
      expect(engine.getCurrentIntent()).toBeNull();
    });
  });

  describe("viewport bounds clamping", () => {
    it("prevents camera from showing area outside source", () => {
      const engine = createEngine();

      // Try to move camera to extreme position
      engine.jumpTo({ x: 0, y: 0, zoom: 2 });
      engine.step(1 / 60);

      const t = engine.getTransform();
      // At zoom 2, viewport is 960x540.
      // Camera center should be at least 480 from left edge
      expect(t.x).toBeGreaterThanOrEqual(sourceSize.width / 4);
      expect(t.y).toBeGreaterThanOrEqual(sourceSize.height / 4);
    });
  });

  describe("real-world agent session simulation", () => {
    it("handles a complete agent workflow", () => {
      const engine = createEngine();
      const events: AgentEvent[] = [
        // Agent navigates to a page
        { type: "navigate", x: 960, y: 540, t: 0 },
        // Clicks search box
        { type: "click", x: 800, y: 200, t: 2000 },
        // Types a search query
        { type: "type", x: 810, y: 200, t: 2500 },
        { type: "type", x: 820, y: 200, t: 2600 },
        { type: "type", x: 830, y: 200, t: 2700 },
        { type: "type", x: 840, y: 200, t: 2800 },
        // Scrolls through results
        { type: "scroll", x: 960, y: 400, t: 4000 },
        { type: "scroll", x: 960, y: 500, t: 4200 },
        // Clicks a result
        { type: "click", x: 600, y: 450, t: 5000 },
      ];

      for (const e of events) {
        engine.pushEvent(e);
      }

      const timeline = engine.processTimeline(30, 7);

      expect(timeline.length).toBeGreaterThan(100); // 7 seconds at 30fps = 210 frames
      expect(timeline.length).toBeLessThan(300);

      // Verify zoom changes over time
      const earlyZoom = timeline[0].camera.zoom;
      const midZoom = timeline[Math.floor(timeline.length / 2)].camera.zoom;

      // At least one zoom should differ from 1.0
      const hasZoomChange = timeline.some((f) => Math.abs(f.camera.zoom - 1) > 0.1);
      expect(hasZoomChange).toBe(true);

      // All transforms should be finite
      for (const frame of timeline) {
        expect(Number.isFinite(frame.camera.x)).toBe(true);
        expect(Number.isFinite(frame.camera.y)).toBe(true);
        expect(Number.isFinite(frame.camera.zoom)).toBe(true);
      }
    });
  });
});
