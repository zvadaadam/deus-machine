// Title fetch after a successful claude turn: claude-only, needs cwd +
// native id, retries until the SDK summary materializes, gives the backend
// the title exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockNotifyTitle, mockListSessions } = vi.hoisted(() => ({
  mockNotifyTitle: vi.fn(() => true),
  mockListSessions: vi.fn(async () => [{ sessionId: "native-1", summary: "Fix login flow" }]),
}));

vi.mock("../host-link", () => ({
  notifyTitle: mockNotifyTitle,
  setHost: vi.fn(),
  HostRpc: {},
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSessions: mockListSessions,
}));

import { maybeFetchTitle } from "../title-watch";
import { trackedSessions } from "../session-tracker";

describe("maybeFetchTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trackedSessions.clear();
  });

  afterEach(() => {
    trackedSessions.clear();
  });

  it("fetches the SDK summary once when cwd + native id are known", async () => {
    trackedSessions.set("s1", {
      harness: "claude-code",
      cwd: "/tmp/w",
      nativeSessionId: "native-1",
    });
    maybeFetchTitle("s1");
    await vi.waitFor(() =>
      expect(mockNotifyTitle).toHaveBeenCalledWith({
        sessionId: "s1",
        agentHarness: "claude-code",
        title: "Fix login flow",
      })
    );
    // Flag flips only on SUCCESS (a missing summary retries next turn).
    expect(trackedSessions.get("s1")?.titleFetched).toBe(true);
    mockNotifyTitle.mockClear();
    maybeFetchTitle("s1");
    await new Promise((r) => setImmediate(r));
    expect(mockNotifyTitle).not.toHaveBeenCalled();
  });

  it("keeps retrying when the host is disconnected at push time", async () => {
    mockNotifyTitle.mockReturnValueOnce(false);
    trackedSessions.set("s1", {
      harness: "claude-code",
      cwd: "/tmp/w",
      nativeSessionId: "native-1",
    });
    maybeFetchTitle("s1");
    await vi.waitFor(() => expect(mockNotifyTitle).toHaveBeenCalledTimes(1));
    // Dropped push must not burn the attempt.
    expect(trackedSessions.get("s1")?.titleFetched).toBeFalsy();
    // Host back: next turn end delivers and latches.
    maybeFetchTitle("s1");
    await vi.waitFor(() => expect(trackedSessions.get("s1")?.titleFetched).toBe(true));
  });

  it("retries while the summary is missing", async () => {
    mockListSessions.mockResolvedValueOnce([{ sessionId: "native-1", summary: undefined as any }]);
    trackedSessions.set("s1", {
      harness: "claude-code",
      cwd: "/tmp/w",
      nativeSessionId: "native-1",
    });
    maybeFetchTitle("s1");
    await new Promise((r) => setImmediate(r));
    expect(trackedSessions.get("s1")?.titleFetched).toBeFalsy();
    // Next turn end retries and succeeds.
    maybeFetchTitle("s1");
    await vi.waitFor(() => expect(trackedSessions.get("s1")?.titleFetched).toBe(true));
  });

  it("skips when the native session id is unknown", async () => {
    trackedSessions.set("s1", { harness: "claude-code", cwd: "/tmp/w" });
    maybeFetchTitle("s1");
    await new Promise((r) => setImmediate(r));
    expect(mockNotifyTitle).not.toHaveBeenCalled();
  });

  it("skips for codex harnesses", async () => {
    trackedSessions.set("s2", {
      harness: "codex-app-server",
      cwd: "/tmp/w",
      nativeSessionId: "native-1",
    });
    maybeFetchTitle("s2");
    await new Promise((r) => setImmediate(r));
    expect(mockNotifyTitle).not.toHaveBeenCalled();
  });
});
