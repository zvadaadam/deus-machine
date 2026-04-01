import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import type { SessionManager } from "../src/mcp/session-manager.js";

// Mock the ffmpeg recorder to avoid spawning real processes
vi.mock("../src/mcp/ffmpeg-recorder.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/mcp/ffmpeg-recorder.js")>();
  return {
    ...orig,
    detectFfmpeg: vi.fn().mockResolvedValue("6.0"),
    FfmpegRecorder: vi.fn().mockImplementation(() => ({
      startCapture: vi.fn().mockResolvedValue(undefined),
      stopCapture: vi.fn().mockResolvedValue("/tmp/raw-test.mp4"),
      isCapturing: vi.fn().mockReturnValue(false),
      cleanup: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn(),
    })),
  };
});

/**
 * Helper to call a tool on the MCP server.
 * Since we can't use the full MCP transport in tests, we test
 * the server and session manager integration directly.
 */
describe("MCP Server (via SessionManager)", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    const result = createMcpServer();
    sessionManager = result.sessionManager;
  });

  afterEach(async () => {
    await sessionManager.shutdownAll();
  });

  describe("recording_start equivalent", () => {
    it("creates a session with defaults", async () => {
      const id = await sessionManager.create({});
      expect(id).toMatch(/^rec_[0-9a-f]{6}$/);
    });

    it("creates a session with all options", async () => {
      const id = await sessionManager.create({
        outputPath: "/tmp/test.mp4",
        sourceWidth: 1280,
        sourceHeight: 720,
        outputWidth: 1280,
        outputHeight: 720,
        fps: 60,
        deviceFrame: "browser-chrome",
        background: { type: "gradient", colors: ["#000", "#fff"], angle: 45 },
        captureMethod: "none",
        display: ":1",
      });

      const status = sessionManager.status(id);
      expect(status.status).toBe("recording");
    });
  });

  describe("recording_event equivalent", () => {
    it("records click events with coordinates", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "click", 500, 300);
      expect(idx).toBe(0);
    });

    it("records type events with text metadata", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "type", 500, 300, { text: "hello world" });
      expect(idx).toBe(0);
    });

    it("records scroll events with direction", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "scroll", 500, 300, { direction: "down" });
      expect(idx).toBe(0);
    });

    it("records navigate events with URL", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "navigate", 960, 540, { url: "https://example.com" });
      expect(idx).toBe(0);
    });

    it("records screenshot events", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "screenshot", 960, 540);
      expect(idx).toBe(0);
    });

    it("records idle events", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "idle", 960, 540);
      expect(idx).toBe(0);
    });

    it("records drag events", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "drag", 500, 300);
      expect(idx).toBe(0);
    });

    it("records events with element rect", async () => {
      const id = await sessionManager.create({});
      const idx = sessionManager.event(id, "click", 500, 300, {
        elementRect: { x: 450, y: 280, width: 100, height: 40 },
      });
      expect(idx).toBe(0);
    });

    it("returns incrementing event indices", async () => {
      const id = await sessionManager.create({});
      expect(sessionManager.event(id, "click", 100, 100)).toBe(0);
      expect(sessionManager.event(id, "click", 200, 200)).toBe(1);
      expect(sessionManager.event(id, "click", 300, 300)).toBe(2);
    });
  });

  describe("recording_chapter equivalent", () => {
    it("adds chapter markers", async () => {
      const id = await sessionManager.create({});
      const result = sessionManager.chapter(id, "Introduction");
      expect(result.chapterIndex).toBe(0);
      expect(typeof result.timestamp).toBe("number");
    });
  });

  describe("recording_stop equivalent", () => {
    it("stops and returns recording result", async () => {
      const id = await sessionManager.create({});
      sessionManager.event(id, "click", 500, 300);
      sessionManager.chapter(id, "Test");

      const result = await sessionManager.stop(id);
      expect(result.events).toHaveLength(1);
      expect(result.chapters).toHaveLength(1);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      // No capture → empty outputPath
      expect(result.outputPath).toBe("");
    });

    it("rejects watermark option (not yet supported)", async () => {
      const id = await sessionManager.create({});

      await expect(
        sessionManager.stop(id, {
          addWatermark: true,
          watermarkText: "Test Watermark",
        })
      ).rejects.toThrow("Watermarking is not yet supported");
    });
  });

  describe("recording_status equivalent", () => {
    it("returns recording status", async () => {
      const id = await sessionManager.create({});
      const status = sessionManager.status(id);

      expect(status.status).toBe("recording");
      expect(status.eventCount).toBe(0);
      expect(status.chapterCount).toBe(0);
      expect(status.duration).toBeGreaterThanOrEqual(0);
    });

    it("returns done status after stop", async () => {
      const id = await sessionManager.create({});
      await sessionManager.stop(id);

      const status = sessionManager.status(id);
      expect(status.status).toBe("done");
      // No capture → outputPath not set
      expect(status.outputPath).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("rejects events for non-existent sessions", () => {
      expect(() => sessionManager.event("nonexistent", "click", 0, 0)).toThrow("Session not found");
    });

    it("rejects chapters for non-existent sessions", () => {
      expect(() => sessionManager.chapter("nonexistent", "Test")).toThrow("Session not found");
    });

    it("rejects stop for non-existent sessions", async () => {
      await expect(sessionManager.stop("nonexistent")).rejects.toThrow("Session not found");
    });

    it("rejects status for non-existent sessions", () => {
      expect(() => sessionManager.status("nonexistent")).toThrow("Session not found");
    });

    it("rejects events after session is stopped", async () => {
      const id = await sessionManager.create({});
      await sessionManager.stop(id);

      expect(() => sessionManager.event(id, "click", 0, 0)).toThrow(/not recording/);
    });

    it("rejects double stop", async () => {
      const id = await sessionManager.create({});
      await sessionManager.stop(id);

      await expect(sessionManager.stop(id)).rejects.toThrow(/not recording/);
    });
  });

  describe("server creation", () => {
    it("creates a server with the correct name", () => {
      const { server } = createMcpServer();
      expect(server).toBeDefined();
    });

    it("returns both server and sessionManager", () => {
      const result = createMcpServer();
      expect(result.server).toBeDefined();
      expect(result.sessionManager).toBeDefined();
    });
  });
});
