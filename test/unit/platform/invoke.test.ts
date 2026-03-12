import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import {
  WORKSPACE_PROGRESS,
  SESSION_MESSAGE,
  QUERY_INVALIDATE,
} from "@shared/events";

// Simulate Tauri environment so isTauriEnv = true at module evaluation time
const originalWindow = globalThis.window;
// @ts-expect-error — minimal mock for isTauriEnv detection
globalThis.window = { __TAURI__: true };

// Track the handlers registered with tauriListen so we can simulate events
let capturedHandlers: Map<string, (event: { payload: unknown }) => void>;
const mockUnlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    capturedHandlers.set(event, handler);
    return Promise.resolve(mockUnlisten);
  }),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/utils/errorReporting", () => ({
  normalizeError: vi.fn((e: unknown) => e),
  reportError: vi.fn(),
}));

// Must import AFTER mocks and window setup
const { listen } = await import("@/platform/tauri/invoke");

afterAll(() => {
  globalThis.window = originalWindow;
});

describe("listen() Zod validation", () => {
  beforeEach(() => {
    capturedHandlers = new Map();
    vi.clearAllMocks();
  });

  it("passes validated payload to handler for known events", async () => {
    const handler = vi.fn();
    await listen(WORKSPACE_PROGRESS, handler);

    const tauriHandler = capturedHandlers.get("workspace:progress");
    expect(tauriHandler).toBeDefined();

    // Simulate a valid event from Rust
    tauriHandler!({
      payload: { workspaceId: "ws-1", step: "dependencies", label: "Installing..." },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      payload: { workspaceId: "ws-1", step: "dependencies", label: "Installing..." },
    });
  });

  it("strips unknown fields from validated payload", async () => {
    const handler = vi.fn();
    await listen(QUERY_INVALIDATE, handler);

    const tauriHandler = capturedHandlers.get("query:invalidate");

    // Rust sends extra field not in the schema
    tauriHandler!({
      payload: { resources: ["workspaces"], _rustInternal: true },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const receivedPayload = handler.mock.calls[0][0].payload;
    expect(receivedPayload.resources).toEqual(["workspaces"]);
    expect(receivedPayload).not.toHaveProperty("_rustInternal");
  });

  it("logs error but still delivers original payload on validation failure", async () => {
    const handler = vi.fn();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await listen(WORKSPACE_PROGRESS, handler);

    const tauriHandler = capturedHandlers.get("workspace:progress");

    // Simulate malformed payload from Rust (missing required fields)
    tauriHandler!({
      payload: { workspaceId: "ws-1" }, // missing step and label
    });

    // Handler should still be called with original (invalid) payload
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      payload: { workspaceId: "ws-1" },
    });

    // Error should be logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Event "workspace:progress" payload failed schema validation'),
      expect.anything(),
    );

    consoleSpy.mockRestore();
  });

  it("passes through without validation for unknown event names", async () => {
    const handler = vi.fn();
    await listen<{ custom: boolean }>("custom:unknown-event", handler);

    const tauriHandler = capturedHandlers.get("custom:unknown-event");
    expect(tauriHandler).toBeDefined();

    // Any payload shape should pass through without validation
    tauriHandler!({
      payload: { custom: true, anything: "goes" },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      payload: { custom: true, anything: "goes" },
    });
  });

  it("returns a callable unlisten function", async () => {
    const handler = vi.fn();
    const unlisten = await listen(SESSION_MESSAGE, handler);

    expect(typeof unlisten).toBe("function");
  });
});
