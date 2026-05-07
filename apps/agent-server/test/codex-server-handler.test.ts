import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerNotification } from "../agents/codex-server/codex-server-types";

const {
  mockBlockIfCodexServerNotInitialized,
  mockGetCodexServerExecutablePath,
  mockInitializeCodexServer,
  mockEventBroadcaster,
  mockClient,
  mockCodexAppServerClient,
} = vi.hoisted(() => {
  const mockClient = {
    initialize: vi.fn(),
    request: vi.fn(),
    onNotification: vi.fn(),
    close: vi.fn(),
  };

  return {
    mockBlockIfCodexServerNotInitialized: vi.fn(),
    mockGetCodexServerExecutablePath: vi.fn(),
    mockInitializeCodexServer: vi.fn(),
    mockEventBroadcaster: {
      emitAgentSessionId: vi.fn(),
      emitPartEvent: vi.fn(),
      emitSessionIdle: vi.fn(),
      emitSessionError: vi.fn(),
      emitSessionCancelled: vi.fn(),
      emitMessageCancelled: vi.fn(),
    },
    mockClient,
    mockCodexAppServerClient: vi.fn(function () {
      return mockClient;
    }),
  };
});

vi.mock("../agents/codex-server/codex-server-discovery", () => ({
  blockIfCodexServerNotInitialized: mockBlockIfCodexServerNotInitialized,
  getCodexServerExecutablePath: mockGetCodexServerExecutablePath,
  initializeCodexServer: mockInitializeCodexServer,
}));

vi.mock("../agents/codex-server/codex-server-client", () => ({
  CodexAppServerClient: mockCodexAppServerClient,
}));

vi.mock("../event-broadcaster", () => ({
  EventBroadcaster: mockEventBroadcaster,
}));

vi.mock("../agents/environment", () => ({
  buildAgentEnvironment: vi.fn(() => ({})),
  buildWorkspaceContext: vi.fn(() => "workspace context"),
}));

import { CodexServerAgentHandler } from "../agents/codex-server/codex-server-handler";
import { codexServerSessions } from "../agents/codex-server/codex-server-session";

describe("CodexServerAgentHandler", () => {
  let notificationHandler: ((notification: CodexAppServerNotification) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    codexServerSessions.clear();
    notificationHandler = undefined;

    mockBlockIfCodexServerNotInitialized.mockReturnValue(false);
    mockGetCodexServerExecutablePath.mockReturnValue("/usr/local/bin/codex");
    mockInitializeCodexServer.mockReturnValue({ success: true });
    mockClient.initialize.mockResolvedValue(undefined);
    mockClient.onNotification.mockImplementation((handler) => {
      notificationHandler = handler;
      return vi.fn();
    });
  });

  it("does not mark failed Codex app-server turns idle", async () => {
    mockClient.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          emitTurn("turn/started", "inProgress");
          emitTurn("turn/completed", "failed", "tool failed");
        });
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });

    const handler = new CodexServerAgentHandler();
    await handler.query("sess-failed", "hello", { cwd: "/repo", model: "gpt-5.5" });
    await flushAsyncWork();

    expect(mockEventBroadcaster.emitSessionIdle).not.toHaveBeenCalled();
    expect(mockEventBroadcaster.emitSessionError).toHaveBeenCalledWith(
      "sess-failed",
      "codex-server",
      "tool failed",
      "internal"
    );
  });

  it("reports interrupted Codex app-server turns as cancelled", async () => {
    mockClient.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          emitTurn("turn/started", "inProgress");
          emitTurn("turn/completed", "interrupted");
        });
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });

    const handler = new CodexServerAgentHandler();
    await handler.query("sess-interrupted", "hello", { cwd: "/repo", model: "gpt-5.5" });
    await flushAsyncWork();

    expect(mockEventBroadcaster.emitSessionIdle).not.toHaveBeenCalled();
    expect(mockEventBroadcaster.emitSessionCancelled).toHaveBeenCalledWith(
      "sess-interrupted",
      "codex-server"
    );
    expect(mockEventBroadcaster.emitMessageCancelled).toHaveBeenCalledWith(
      "sess-interrupted",
      "codex-server"
    );
  });

  it("rejects unsupported thinking levels before starting a Codex turn", async () => {
    mockClient.request.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      return {};
    });

    const handler = new CodexServerAgentHandler();
    await handler.query("sess-bad-thinking", "hello", {
      cwd: "/repo",
      model: "gpt-5.5",
      thinkingLevel: "MAX" as any,
    });
    await flushAsyncWork();

    expect(mockClient.request).not.toHaveBeenCalledWith(
      "turn/start",
      expect.anything(),
      expect.anything()
    );
    expect(mockEventBroadcaster.emitSessionError).toHaveBeenCalledWith(
      "sess-bad-thinking",
      "codex-server",
      expect.stringContaining("Unsupported Codex thinking level: MAX"),
      "internal"
    );
  });

  function emitTurn(
    method: "turn/started" | "turn/completed",
    status: "completed" | "interrupted" | "failed" | "inProgress",
    error?: string
  ) {
    notificationHandler?.({
      method,
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status,
          error: error ? { message: error } : null,
        },
      },
    });
  }
});

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
