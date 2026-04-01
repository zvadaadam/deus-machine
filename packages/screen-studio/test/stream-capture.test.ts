/**
 * Unit tests for StreamRecorder.
 *
 * Uses a mock WebSocket server (via `ws` package) and a mock ffmpeg process
 * to exercise the frame capture pipeline without real external dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable, type WritableOptions } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Mock child_process.spawn — prevents real ffmpeg from running.
// Returns a fake ChildProcess with a controllable stdin Writable.
// ---------------------------------------------------------------------------

/** Controllable stdin that can simulate backpressure. */
class MockStdin extends Writable {
  /** When true, write() returns false and queues a drain event. */
  simulateBackpressure = false;
  bytesWritten = 0;
  writeCount = 0;

  constructor(opts?: WritableOptions) {
    super(opts);
  }

  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.bytesWritten += chunk.length;
    this.writeCount++;
    callback();
  }

  override write(
    chunk: any,
    encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
    cb?: (error: Error | null | undefined) => void
  ): boolean {
    const result = super.write(chunk, encodingOrCb as any, cb as any);
    if (this.simulateBackpressure) {
      // Emit drain on next tick so the backpressure path resolves
      process.nextTick(() => this.emit("drain"));
      return false;
    }
    return result;
  }
}

let mockStdin: MockStdin;
let mockFfmpegProcess: EventEmitter & {
  stdin: MockStdin;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockFfmpeg() {
  mockStdin = new MockStdin();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdin: mockStdin,
    stderr,
    kill: vi.fn(() => {
      proc.emit("close", 0);
    }),
    pid: 12345,
  });
  mockFfmpegProcess = proc;
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => createMockFfmpeg()),
}));

// Mock fs to avoid real file system checks during stop()
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    existsSync: vi.fn(() => true),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
  };
});

// ---------------------------------------------------------------------------
// Import StreamRecorder AFTER mocks are set up
// ---------------------------------------------------------------------------

import { StreamRecorder } from "../src/mcp/stream-capture.js";

// ---------------------------------------------------------------------------
// Mock WebSocket server helpers using `ws` package
// ---------------------------------------------------------------------------

import { WebSocketServer as WsServer } from "ws";

/** Create a WS server on a random port that auto-closes after each test. */
function createMockWsServer(): { server: WsServer; port: number; close: () => Promise<void> } {
  const server = new WsServer({ port: 0 });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  if (port === 0) throw new Error("Failed to bind mock WS server");

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      }),
  };
}

/** Helper: create a base64-encoded minimal JPEG (2x2 red pixel). */
function makeFrameMessage(metadata?: { deviceWidth?: number; deviceHeight?: number }): string {
  // Minimal valid JPEG: 2x2 red pixels (107 bytes)
  const minimalJpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
      "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh" +
      "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR" +
      "CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAAf//aAAwDAQACEQMRAD8AAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Af//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Af//Z",
    "base64"
  );

  return JSON.stringify({
    type: "frame",
    data: minimalJpeg.toString("base64"),
    metadata: metadata ?? { deviceWidth: 1280, deviceHeight: 720 },
  });
}

function makeStatusMessage(connected = true, screencasting = true): string {
  return JSON.stringify({ type: "status", connected, screencasting });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamRecorder", () => {
  let recorder: StreamRecorder;
  let wsContext: ReturnType<typeof createMockWsServer> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    recorder = new StreamRecorder({
      outputPath: "/tmp/test-stream.mp4",
      fps: 10,
      readyTimeout: 2000,
    });
  });

  afterEach(async () => {
    // Clean up recorder
    try {
      recorder.kill();
    } catch {
      // already killed
    }

    // Clean up WS server
    if (wsContext) {
      await wsContext.close();
      wsContext = null;
    }
  });

  // =========================================================================
  // 1. Happy path: frames arrive and are counted
  // =========================================================================

  describe("happy path", () => {
    it("counts frames received from mock WS server", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      // When a client connects, send 5 frame messages
      server.on("connection", (ws) => {
        for (let i = 0; i < 5; i++) {
          ws.send(makeFrameMessage());
        }
      });

      await recorder.start(port);

      // Give time for messages to arrive and be processed
      await new Promise((r) => setTimeout(r, 200));

      expect(recorder.frames).toBe(5);
      expect(recorder.dropped).toBe(0);
      expect(recorder.isCapturing).toBe(true);
    });

    it("detects frame dimensions from metadata", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send(makeFrameMessage({ deviceWidth: 1920, deviceHeight: 1080 }));
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      expect(recorder.detectedFrameSize).toEqual({ width: 1920, height: 1080 });
    });

    it("pipes frame data to ffmpeg stdin", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send(makeFrameMessage());
        ws.send(makeFrameMessage());
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      // The mock stdin should have received write calls
      expect(mockStdin.writeCount).toBeGreaterThanOrEqual(2);
      expect(mockStdin.bytesWritten).toBeGreaterThan(0);
    });

    it("stop() returns outputPath when frames were captured", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send(makeFrameMessage());
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      // Mock ffmpeg close event when stdin ends
      const stdinEndPromise = new Promise<void>((resolve) => {
        mockStdin.on("finish", () => {
          mockFfmpegProcess.emit("close", 0);
          resolve();
        });
      });

      const result = await recorder.stop();
      expect(result).toBe("/tmp/test-stream.mp4");
    });
  });

  // =========================================================================
  // 2. Connection failure: WS server not available
  // =========================================================================

  describe("connection failure", () => {
    it("handles gracefully when WS server is not available", async () => {
      // Use a port that nothing is listening on
      const unusedPort = 19999;

      // start() should not throw — it schedules reconnects
      await recorder.start(unusedPort);

      expect(recorder.frames).toBe(0);
      expect(recorder.isCapturing).toBe(true);
    });
  });

  // =========================================================================
  // 3. Reconnect: WS server disconnects mid-stream
  // =========================================================================

  describe("reconnect", () => {
    it("reconnects after server disconnect and continues capturing", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      let connectionCount = 0;
      server.on("connection", (ws) => {
        connectionCount++;
        // Send a frame on first connection
        ws.send(makeFrameMessage());

        if (connectionCount === 1) {
          // Close the first connection after a short delay to trigger reconnect
          setTimeout(() => ws.close(), 100);
        } else {
          // Second connection: send another frame
          setTimeout(() => ws.send(makeFrameMessage()), 50);
        }
      });

      await recorder.start(port);

      // Wait for reconnect cycle: disconnect + delay + reconnect + message
      await new Promise((r) => setTimeout(r, 2000));

      // Should have connected at least twice
      expect(connectionCount).toBeGreaterThanOrEqual(2);
      // Should have frames from both connections
      expect(recorder.frames).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // 4. Backpressure: ffmpeg can't keep up
  // =========================================================================

  describe("backpressure", () => {
    it("drops frames when encoder is backpressured", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        // Send first frame normally
        ws.send(makeFrameMessage());
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      // First frame should have been accepted
      expect(recorder.frames).toBe(1);

      // Now simulate backpressure: next write will return false
      mockStdin.simulateBackpressure = true;

      // Send more frames via the mock server
      for (const client of wsContext.server.clients) {
        // This frame triggers backpressure
        client.send(makeFrameMessage());
      }

      await new Promise((r) => setTimeout(r, 100));

      // The frame that triggered backpressure is still written (write returns false
      // but the data IS buffered), so frameCount increments. But encoderBackpressured
      // is now set, so subsequent frames will be dropped.
      expect(recorder.frames).toBe(2);

      // Send frames while backpressured — these should be dropped
      for (const client of wsContext.server.clients) {
        client.send(makeFrameMessage());
        client.send(makeFrameMessage());
      }

      await new Promise((r) => setTimeout(r, 100));

      // The drain event fires (from our nextTick in MockStdin), which clears
      // backpressure. But there's a race: the two frames above may arrive
      // before drain fires. Check that at least some were dropped.
      // Since drain fires on nextTick after the write that set backpressure,
      // the subsequent messages should see backpressured=true.
      expect(recorder.dropped).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 5. Single frame then silence
  // =========================================================================

  describe("1 frame then silence", () => {
    it("correctly reports frameCount=1 when only one frame arrives", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        // Send exactly one frame then go silent
        ws.send(makeFrameMessage());
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 500));

      expect(recorder.frames).toBe(1);
      expect(recorder.dropped).toBe(0);
      // actualFps is null with only 1 frame (needs at least 2)
      expect(recorder.actualFps).toBeNull();
    });
  });

  // =========================================================================
  // 6. Status messages don't count as frames
  // =========================================================================

  describe("status messages", () => {
    it("does not count status messages as frames", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send(makeStatusMessage(true, true));
        ws.send(makeFrameMessage());
        ws.send(makeStatusMessage(true, false));
        ws.send(makeFrameMessage());
        ws.send(makeStatusMessage(false, false));
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 300));

      // Only frame messages should be counted
      expect(recorder.frames).toBe(2);
    });
  });

  // =========================================================================
  // 7. Malformed messages
  // =========================================================================

  describe("malformed messages", () => {
    it("handles invalid JSON without crashing", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send("this is not valid JSON{{{");
        ws.send("{truncated");
        ws.send("");
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      // Should not crash, frameCount stays 0
      expect(recorder.frames).toBe(0);
      expect(recorder.isCapturing).toBe(true);
    });

    it("handles messages with missing data field", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        // Valid JSON but missing the `data` field
        ws.send(JSON.stringify({ type: "frame" }));
        // Has type but data is null
        ws.send(JSON.stringify({ type: "frame", data: null }));
        // Unknown type
        ws.send(JSON.stringify({ type: "unknown", data: "abc" }));
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      // None of these should count as valid frames
      expect(recorder.frames).toBe(0);
      expect(recorder.isCapturing).toBe(true);
    });

    it("handles valid frame after malformed messages", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send("GARBAGE");
        ws.send(JSON.stringify({ type: "frame" })); // missing data
        ws.send(makeFrameMessage()); // valid frame
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 200));

      expect(recorder.frames).toBe(1);
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("kill() stops all activity immediately", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        ws.send(makeFrameMessage());
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 100));

      recorder.kill();

      expect(recorder.isCapturing).toBe(false);
    });

    it("stop() returns null when no frames were captured", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      // Server accepts connection but sends no frames
      server.on("connection", () => {
        // intentionally empty
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 100));

      // Mock ffmpeg close when stdin ends
      mockStdin.on("finish", () => {
        mockFfmpegProcess.emit("close", 0);
      });

      const result = await recorder.stop();
      expect(result).toBeNull();
    });

    it("actualFps is computed from timestamps of 2+ frames", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      server.on("connection", (ws) => {
        // Send frames with some delay between them
        ws.send(makeFrameMessage());
        setTimeout(() => ws.send(makeFrameMessage()), 100);
        setTimeout(() => ws.send(makeFrameMessage()), 200);
      });

      await recorder.start(port);
      await new Promise((r) => setTimeout(r, 500));

      expect(recorder.frames).toBe(3);
      // With ~100ms between frames, fps should be roughly ~10
      const fps = recorder.actualFps;
      expect(fps).not.toBeNull();
      expect(fps!).toBeGreaterThan(0);
      expect(fps!).toBeLessThan(50); // reasonable upper bound
    });

    it("keepalive messages are sent to the server", async () => {
      wsContext = createMockWsServer();
      const { server, port } = wsContext;

      const receivedMessages: string[] = [];

      server.on("connection", (ws) => {
        ws.on("message", (data) => {
          receivedMessages.push(data.toString());
        });
        // Send a frame to trigger readyResolve
        ws.send(makeFrameMessage());
      });

      await recorder.start(port);
      // Wait for at least a couple keepalive ticks (100ms interval)
      await new Promise((r) => setTimeout(r, 350));

      // Should have received keepalive mouse move messages
      const keepalives = receivedMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === "input_mouse";
        } catch {
          return false;
        }
      });

      expect(keepalives.length).toBeGreaterThan(0);
    });
  });
});
