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

  it("rejects unsupported thinking levels before starting a Codex thread", async () => {
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

    expect(mockCodexAppServerClient).not.toHaveBeenCalled();
    expect(mockClient.request).not.toHaveBeenCalled();
    expect(mockEventBroadcaster.emitSessionError).toHaveBeenCalledWith(
      "sess-bad-thinking",
      "codex-server",
      expect.stringContaining("Unsupported Codex thinking level: MAX"),
      "internal"
    );
  });

  it("starts a fresh unpersisted Codex thread when entering goal mode", async () => {
    const threadStartParams: unknown[] = [];
    let startedThreads = 0;

    mockClient.request.mockImplementation(async (method: string, params: any) => {
      if (method === "thread/start") {
        threadStartParams.push(params);
        startedThreads += 1;
        return { thread: { id: `thread-${startedThreads}` } };
      }
      if (method === "turn/start") {
        const threadId = params.threadId;
        queueMicrotask(() => {
          emitTurn("turn/started", "inProgress", undefined, threadId);
          emitTurn("turn/completed", "completed", undefined, threadId);
        });
        return { turn: { id: `turn-${startedThreads}`, status: "inProgress" } };
      }
      return {};
    });

    const handler = new CodexServerAgentHandler();
    await handler.query("sess-goal", "normal", { cwd: "/repo", model: "gpt-5.5" });
    await flushAsyncWork();

    await handler.query("sess-goal", "goal", {
      cwd: "/repo",
      model: "gpt-5.5",
      goalContext: {
        objective: "Ship goal mode",
        tokenBudget: null,
        spentTokens: 0,
        startedAt: 100,
      },
    });
    await flushAsyncWork();

    expect(threadStartParams).toHaveLength(2);
    expect(threadStartParams[0]).not.toHaveProperty("dynamicTools");
    expect(threadStartParams[1]).toMatchObject({
      dynamicTools: [
        expect.objectContaining({ name: "update_goal" }),
        expect.objectContaining({ name: "askUserQuestion" }),
      ],
    });
    expect(mockEventBroadcaster.emitAgentSessionId).toHaveBeenCalledTimes(1);
    expect(mockEventBroadcaster.emitAgentSessionId).toHaveBeenCalledWith("sess-goal", "thread-1");
  });

  it("omits askUserQuestion dynamic tool when goal questions are disabled", async () => {
    const threadStartParams: unknown[] = [];

    mockClient.request.mockImplementation(async (method: string, params: any) => {
      if (method === "thread/start") {
        threadStartParams.push(params);
        return { thread: { id: "thread-no-questions" } };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          emitTurn("turn/started", "inProgress", undefined, params.threadId);
          emitTurn("turn/completed", "completed", undefined, params.threadId);
        });
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });

    const handler = new CodexServerAgentHandler();
    await handler.query("sess-no-questions", "goal", {
      cwd: "/repo",
      model: "gpt-5.5",
      allowQuestions: false,
      goalContext: {
        objective: "Ship goal mode",
        tokenBudget: null,
        spentTokens: 0,
        startedAt: 100,
      },
    });
    await flushAsyncWork();

    expect(threadStartParams).toHaveLength(1);
    expect(threadStartParams[0]).toMatchObject({
      dynamicTools: [expect.objectContaining({ name: "update_goal" })],
    });
    expect(JSON.stringify(threadStartParams[0])).not.toContain("askUserQuestion");
  });

  function emitTurn(
    method: "turn/started" | "turn/completed",
    status: "completed" | "interrupted" | "failed" | "inProgress",
    error?: string,
    threadId = "thread-1"
  ) {
    notificationHandler?.({
      method,
      params: {
        threadId,
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
