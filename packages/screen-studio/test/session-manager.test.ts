import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/mcp/session-manager.js";

// Mock the FfmpegRecorder to avoid spawning real ffmpeg processes
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

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    await manager.shutdownAll();
  });

  describe("create", () => {
    it("creates a session with default config", async () => {
      const id = await manager.create({});

      expect(id).toMatch(/^rec_[0-9a-f]{6}$/);

      const status = manager.status(id);
      expect(status.status).toBe("recording");
      expect(status.eventCount).toBe(0);
      expect(status.chapterCount).toBe(0);
    });

    it("creates a session with custom config", async () => {
      const id = await manager.create({
        sourceWidth: 1280,
        sourceHeight: 720,
        outputWidth: 1280,
        outputHeight: 720,
        fps: 60,
        deviceFrame: "browser-chrome",
        captureMethod: "none",
      });

      expect(id).toMatch(/^rec_[0-9a-f]{6}$/);
      expect(manager.status(id).status).toBe("recording");
    });

    it("creates multiple concurrent sessions", async () => {
      const id1 = await manager.create({});
      const id2 = await manager.create({});
      const id3 = await manager.create({});

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(manager.activeCount).toBe(3);
    });
  });

  describe("event", () => {
    it("records a click event", async () => {
      const id = await manager.create({});

      const eventIndex = manager.event(id, "click", 500, 300);
      expect(eventIndex).toBe(0);

      const status = manager.status(id);
      expect(status.eventCount).toBe(1);
    });

    it("records multiple events in sequence", async () => {
      const id = await manager.create({});

      manager.event(id, "click", 500, 300);
      manager.event(id, "type", 500, 300, { text: "hello" });
      manager.event(id, "scroll", 500, 600, { direction: "down" });
      manager.event(id, "navigate", 960, 540, { url: "https://example.com" });

      const status = manager.status(id);
      expect(status.eventCount).toBe(4);
    });

    it("records events with element rect metadata", async () => {
      const id = await manager.create({});

      const eventIndex = manager.event(id, "click", 500, 300, {
        elementRect: { x: 450, y: 280, width: 100, height: 40 },
      });

      expect(eventIndex).toBe(0);
    });

    it("throws when session is not found", () => {
      expect(() => manager.event("nonexistent", "click", 0, 0)).toThrow(
        "Session not found: nonexistent"
      );
    });

    it("throws when session is not recording", async () => {
      const id = await manager.create({});
      await manager.stop(id);

      expect(() => manager.event(id, "click", 0, 0)).toThrow(/not recording/);
    });
  });

  describe("chapter", () => {
    it("adds a chapter marker", async () => {
      const id = await manager.create({});

      const result = manager.chapter(id, "Getting Started");
      expect(result.chapterIndex).toBe(0);
      expect(result.timestamp).toBeGreaterThanOrEqual(0);

      const status = manager.status(id);
      expect(status.chapterCount).toBe(1);
    });

    it("adds multiple chapters", async () => {
      const id = await manager.create({});

      manager.chapter(id, "Chapter 1");
      manager.chapter(id, "Chapter 2");
      const result = manager.chapter(id, "Chapter 3");

      expect(result.chapterIndex).toBe(2);
      expect(manager.status(id).chapterCount).toBe(3);
    });

    it("throws when session is not found", () => {
      expect(() => manager.chapter("nonexistent", "Test")).toThrow(
        "Session not found: nonexistent"
      );
    });

    it("throws when session is not recording", async () => {
      const id = await manager.create({});
      await manager.stop(id);

      expect(() => manager.chapter(id, "Late Chapter")).toThrow(/not recording/);
    });
  });

  describe("stop", () => {
    it("stops a session and returns result", async () => {
      const id = await manager.create({});

      // Add some events
      manager.event(id, "click", 500, 300);
      manager.event(id, "type", 500, 300, { text: "test" });
      manager.chapter(id, "Test Chapter");

      const result = await manager.stop(id);
      expect(result.events).toHaveLength(2);
      expect(result.chapters).toHaveLength(1);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.outputPath).toContain("recording-");
    });

    it("transitions status from recording to done", async () => {
      const id = await manager.create({});

      expect(manager.status(id).status).toBe("recording");

      await manager.stop(id);
      expect(manager.status(id).status).toBe("done");
    });

    it("throws when stopping a non-recording session", async () => {
      const id = await manager.create({});
      await manager.stop(id);

      await expect(manager.stop(id)).rejects.toThrow(/not recording/);
    });

    it("returns custom output path when specified", async () => {
      const id = await manager.create({
        outputPath: "/tmp/custom-output.mp4",
      });

      const result = await manager.stop(id);
      expect(result.outputPath).toBe("/tmp/custom-output.mp4");
    });
  });

  describe("status", () => {
    it("returns status for an active session", async () => {
      const id = await manager.create({});

      const status = manager.status(id);
      expect(status.status).toBe("recording");
      expect(status.duration).toBeGreaterThanOrEqual(0);
      expect(status.eventCount).toBe(0);
      expect(status.chapterCount).toBe(0);
    });

    it("returns outputPath for completed session", async () => {
      const id = await manager.create({
        outputPath: "/tmp/test-output.mp4",
      });
      await manager.stop(id);

      const status = manager.status(id);
      expect(status.status).toBe("done");
      expect(status.outputPath).toBe("/tmp/test-output.mp4");
    });

    it("throws for non-existent session", () => {
      expect(() => manager.status("nonexistent")).toThrow("Session not found: nonexistent");
    });
  });

  describe("cleanup", () => {
    it("removes a session", async () => {
      const id = await manager.create({});
      await manager.cleanup(id);

      expect(() => manager.status(id)).toThrow("Session not found");
    });

    it("is idempotent for non-existent sessions", async () => {
      // Should not throw
      await manager.cleanup("nonexistent");
    });
  });

  describe("shutdownAll", () => {
    it("stops and cleans up all active sessions", async () => {
      const id1 = await manager.create({});
      const id2 = await manager.create({});
      const id3 = await manager.create({});

      expect(manager.activeCount).toBe(3);

      await manager.shutdownAll();

      expect(manager.activeCount).toBe(0);
      expect(() => manager.status(id1)).toThrow();
      expect(() => manager.status(id2)).toThrow();
      expect(() => manager.status(id3)).toThrow();
    });
  });

  describe("activeCount", () => {
    it("tracks active recording sessions", async () => {
      expect(manager.activeCount).toBe(0);

      const id1 = await manager.create({});
      expect(manager.activeCount).toBe(1);

      const id2 = await manager.create({});
      expect(manager.activeCount).toBe(2);

      await manager.stop(id1);
      expect(manager.activeCount).toBe(1);

      await manager.stop(id2);
      expect(manager.activeCount).toBe(0);
    });
  });

  describe("full lifecycle", () => {
    it("handles create → events → chapters → stop → cleanup", async () => {
      // Create
      const id = await manager.create({
        sourceWidth: 1920,
        sourceHeight: 1080,
        fps: 30,
        captureMethod: "none",
      });
      expect(manager.status(id).status).toBe("recording");

      // Events
      manager.event(id, "navigate", 960, 540, { url: "https://example.com" });
      manager.event(id, "click", 300, 200, {
        elementRect: { x: 280, y: 180, width: 120, height: 40 },
      });
      manager.event(id, "type", 300, 200, { text: "search query" });
      manager.chapter(id, "Search");
      manager.event(id, "click", 500, 400);
      manager.event(id, "scroll", 500, 600, { direction: "down" });
      manager.chapter(id, "Results");

      expect(manager.status(id).eventCount).toBe(5);
      expect(manager.status(id).chapterCount).toBe(2);

      // Stop
      const result = await manager.stop(id);
      expect(result.events).toHaveLength(5);
      expect(result.chapters).toHaveLength(2);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(manager.status(id).status).toBe("done");

      // Cleanup
      await manager.cleanup(id);
      expect(() => manager.status(id)).toThrow();
    });
  });
});
