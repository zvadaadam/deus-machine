import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecordingSession } from "../src/session/recording-session.js";
import type { ElementResolver } from "../src/adapter/mcp-adapter.js";

// Mock performance.now for deterministic timing
let mockTime = 0;
vi.stubGlobal("performance", {
  now: () => mockTime,
});

describe("RecordingSession", () => {
  const sourceSize = { width: 1920, height: 1080 };
  const outputSize = { width: 1920, height: 1080 };

  const mockResolver: ElementResolver = async (ref) => {
    const positions: Record<string, any> = {
      "@e1": { x: 500, y: 300, rect: { x: 400, y: 280, width: 200, height: 40 } },
      "@e5": { x: 800, y: 450, rect: { x: 750, y: 430, width: 100, height: 40 } },
    };
    return positions[ref] ?? null;
  };

  beforeEach(() => {
    mockTime = 0;
  });

  function createSession() {
    return new RecordingSession({
      sourceSize,
      outputSize,
      fps: 30,
      elementResolver: mockResolver,
      deviceFrame: { type: "browser-chrome", title: "https://example.com" },
    });
  }

  describe("lifecycle", () => {
    it("starts in idle state", () => {
      const session = createSession();
      expect(session.getStatus()).toBe("idle");
    });

    it("transitions to recording on start", () => {
      const session = createSession();
      session.start();
      expect(session.getStatus()).toBe("recording");
    });

    it("can pause and resume", () => {
      const session = createSession();
      session.start();
      session.pause();
      expect(session.getStatus()).toBe("paused");
      session.resume();
      expect(session.getStatus()).toBe("recording");
    });

    it("stop returns timeline", () => {
      const session = createSession();
      session.start();

      // Advance some frames
      for (let i = 0; i < 5; i++) {
        mockTime += 33;
        session.tick();
      }

      const timeline = session.stop();
      expect(session.getStatus()).toBe("stopped");
      expect(timeline.length).toBeGreaterThan(0);
    });

    it("stop on idle returns empty", () => {
      const session = createSession();
      const timeline = session.stop();
      expect(timeline).toHaveLength(0);
    });

    it("reset clears everything", () => {
      const session = createSession();
      session.start();
      session.handleAgentEvent({ type: "click", x: 500, y: 300, t: 0 });
      session.reset();

      expect(session.getStatus()).toBe("idle");
      expect(session.getEventLog()).toHaveLength(0);
    });
  });

  describe("handleToolEvent", () => {
    it("processes MCP tool events and pushes to camera engine", async () => {
      const session = createSession();
      session.start();

      await session.handleToolEvent({
        method: "browserClick",
        requestId: "r1",
        params: { ref: "@e5" },
        timestamp: 1000,
      });

      const log = session.getEventLog();
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe("click");
      expect(log[0].x).toBe(800);
      expect(log[0].y).toBe(450);
    });

    it("ignores non-visual tool events", async () => {
      const session = createSession();
      session.start();

      await session.handleToolEvent({
        method: "browserSnapshot",
        requestId: "r2",
        params: {},
      });

      expect(session.getEventLog()).toHaveLength(0);
    });
  });

  describe("handleAgentEvent", () => {
    it("accepts raw events with coordinates", () => {
      const session = createSession();
      session.start();

      session.handleAgentEvent({ type: "click", x: 500, y: 300, t: 0 });

      expect(session.getEventLog()).toHaveLength(1);
    });
  });

  describe("tick", () => {
    it("returns render instructions each frame", () => {
      const session = createSession();
      session.start();

      session.handleAgentEvent({ type: "click", x: 500, y: 300, t: 0 });

      mockTime = 16; // ~60fps
      const result = session.tick();

      expect(result.camera).toBeDefined();
      expect(result.camera.x).toBeDefined();
      expect(result.camera.y).toBeDefined();
      expect(result.camera.zoom).toBeDefined();
      expect(result.instructions).toBeDefined();
      expect(result.instructions.source).toBeDefined();
      expect(result.instructions.content).toBeDefined();
      expect(result.cursor).toBeDefined();
    });

    it("camera moves toward event over time", () => {
      const session = createSession();
      session.start();

      // Click at top-left
      session.handleAgentEvent({ type: "click", x: 200, y: 200, t: 0 });

      const initial = session.currentFrame();

      // Step 3 seconds
      for (let i = 0; i < 180; i++) {
        mockTime += 16;
        session.tick();
      }

      const after = session.tick();

      // Camera should have moved from center toward (200, 200)
      expect(after.camera.x).toBeLessThan(initial.camera.x);
    });

    it("returns current state when paused", () => {
      const session = createSession();
      session.start();
      session.handleAgentEvent({ type: "click", x: 200, y: 200, t: 0 });

      mockTime = 16;
      session.tick();
      session.pause();

      const paused1 = session.tick();
      mockTime = 100;
      const paused2 = session.tick();

      // Should be the same since we're paused
      expect(paused1.camera.x).toBe(paused2.camera.x);
    });

    it("cursor state includes velocity from spring animation", () => {
      const session = createSession();
      session.start();

      session.handleAgentEvent({ type: "click", x: 200, y: 200, t: 0 });
      mockTime = 16;
      const result = session.tick();

      // Cursor should have velocity while spring is animating
      expect(result.cursor.vx).toBeDefined();
      expect(result.cursor.vy).toBeDefined();
      // Moving from center (960,540) toward (200,200), velocity should be negative
      expect(result.cursor.vx).toBeLessThan(0);
      expect(result.cursor.vy).toBeLessThan(0);
    });
  });

  describe("renderTimeline", () => {
    it("generates timeline from events", () => {
      const session = createSession();

      session.handleAgentEvent({ type: "click", x: 500, y: 300, t: 0 });
      session.handleAgentEvent({ type: "type", x: 500, y: 300, t: 500 });
      session.handleAgentEvent({ type: "type", x: 520, y: 300, t: 1000 });

      const timeline = session.renderTimeline(30);

      expect(timeline.length).toBeGreaterThan(0);
      // All frames should have valid transforms
      for (const frame of timeline) {
        expect(Number.isFinite(frame.camera.x)).toBe(true);
        expect(Number.isFinite(frame.camera.zoom)).toBe(true);
      }
    });
  });

  describe("setTitle", () => {
    it("updates compositor title", () => {
      const session = createSession();
      session.start();
      session.setTitle("https://new-url.com");

      const frame = session.currentFrame();
      expect(frame.instructions.deviceFrame?.title).toBe("https://new-url.com");
    });
  });

  describe("jumpCamera", () => {
    it("instantly moves camera", () => {
      const session = createSession();
      session.jumpCamera({ x: 200, y: 200, zoom: 2 });

      const frame = session.currentFrame();
      expect(frame.camera.x).toBe(200);
      expect(frame.camera.y).toBe(200);
      expect(frame.camera.zoom).toBe(2);
    });
  });

  describe("full workflow simulation", () => {
    it("handles a complete browser agent session", async () => {
      const session = createSession();
      session.start();

      // Agent navigates
      await session.handleToolEvent({
        method: "browserNavigate",
        requestId: "r1",
        params: { url: "https://example.com" },
        timestamp: 0,
      });

      // Simulate some ticks
      for (let i = 0; i < 30; i++) {
        mockTime += 33;
        session.tick();
      }

      // Agent clicks a button
      await session.handleToolEvent({
        method: "browserClick",
        requestId: "r2",
        params: { ref: "@e5" },
        timestamp: 1000,
      });

      // More ticks
      for (let i = 0; i < 60; i++) {
        mockTime += 33;
        session.tick();
      }

      // Agent types in a field
      await session.handleToolEvent({
        method: "browserType",
        requestId: "r3",
        params: { ref: "@e1", text: "search query" },
        timestamp: 3000,
      });

      // More ticks
      for (let i = 0; i < 60; i++) {
        mockTime += 33;
        session.tick();
      }

      const timeline = session.stop();

      // Should have captured frames
      expect(timeline.length).toBeGreaterThan(0);

      // Event log should have 3 events (navigate, click, type)
      expect(session.getEventLog()).toHaveLength(3);
    });
  });
});
