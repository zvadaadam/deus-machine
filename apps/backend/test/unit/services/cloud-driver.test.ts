// Unit tests for the cloud session driver — the frame→fold contract.
//
// The driver's one promise: agnt session frames become the SAME envelopes the
// local agent-server produces (deus session id, monotonic seq, lifecycle event
// verbatim), and agnt platform frames become deus effects. These tests drive
// the captured onFrame callback directly — no sockets, no network — and assert
// what reaches the (mocked) event handler and the (mocked) socket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Hoisted mocks ----
const mockSend = vi.fn();
const mockClose = vi.fn();
let capturedOnFrame: ((frame: Record<string, unknown>) => void) | null = null;
let capturedOnDown: ((reason: string) => void) | null = null;
let connectCount = 0;
/** Toggled by the reconnect tests: a closed socket reads false. */
let socketOpen = true;

vi.mock("../../../src/services/agent/cloud/session-socket", () => ({
  connectSessionSocket: (options: {
    onFrame: (frame: Record<string, unknown>) => void;
    onDown?: (reason: string) => void;
  }) => {
    connectCount += 1;
    capturedOnFrame = options.onFrame;
    capturedOnDown = options.onDown ?? null;
    return {
      ready: () => Promise.resolve(),
      send: mockSend,
      isOpen: () => socketOpen,
      close: mockClose,
    };
  },
}));

vi.mock("../../../src/services/agent/cloud/config", () => ({
  setCloudIdentityChangedHandler: vi.fn(),
  getCloudConfig: () => ({
    baseUrl: "http://agnt.test",
    apiKey: "agnt_sk_test_x",
    anthropicApiKey: "sk-ant-test",
    claudeOauthToken: null,
  }),
}));

const mockCreateSession = vi.fn(async (_opts: Record<string, unknown>) => ({ id: "agnt-lazy-1" }));
vi.mock("@deus-hq/sdk", () => ({
  createSessionToken: vi.fn(async () => ({ token: "session-jwt" })),
  createSession: (opts: Record<string, unknown>) => mockCreateSession(opts),
}));

const mockRelay = vi.fn(async (..._args: unknown[]) => ({ answers: ["yes"] }));
vi.mock("../../../src/services/agent/tool-relay", () => ({
  relay: (...args: unknown[]) => mockRelay(...args),
}));

vi.mock("../../../src/services/agent/persistence", () => ({
  persistSessionNeedsResponse: vi.fn(() => ({ ok: true })),
  persistSessionBackToWorking: vi.fn(() => ({ ok: true })),
}));

const mockInvalidate = vi.fn();
vi.mock("../../../src/services/query-engine", () => ({
  invalidate: (...args: unknown[]) => mockInvalidate(...args),
}));

const mockBroadcast = vi.fn();
vi.mock("../../../src/services/ws.service", () => ({
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const mockRun = vi.fn();
const mockGet = vi.fn(() => ({ kind: "cloud", provider_workspace_id: "agnt-ws-1" }));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({ prepare: () => ({ run: mockRun, get: mockGet }) }),
}));

vi.mock("../../../src/db", () => ({
  getSessionRaw: vi.fn(() => ({
    id: "deus-session-1",
    workspace_id: "deus-ws-1",
    provider_session_id: "agnt-session-1",
  })),
}));

import {
  initCloudDriver,
  shutdownCloudDriver,
  ensureCloudSession,
  startCloudTurn,
  requestCloudDiff,
} from "../../../src/services/agent/cloud/driver";

function makeHandler() {
  return {
    handle: vi.fn(),
    beginTurn: vi.fn(() => true),
    abortTurn: vi.fn(),
    liveTurnId: vi.fn(() => undefined as string | undefined),
    handleTitle: vi.fn(),
  };
}

let handler: ReturnType<typeof makeHandler>;

beforeEach(async () => {
  vi.clearAllMocks();
  capturedOnFrame = null;
  capturedOnDown = null;
  socketOpen = true;
  handler = makeHandler();
  initCloudDriver(handler);
  await ensureCloudSession("deus-session-1");
});

afterEach(() => {
  shutdownCloudDriver();
});

describe("cloud driver frame → fold contract", () => {
  it("wraps lifecycle frames as envelopes under the deus session id with monotonic seq", () => {
    capturedOnFrame!({ type: "turn.started", sessionId: "agnt-session-1", turnId: "t1" });
    capturedOnFrame!({
      type: "message.started",
      sessionId: "agnt-session-1",
      messageId: "m1",
      role: "assistant",
    });

    expect(handler.handle).toHaveBeenCalledTimes(2);
    const [first, second] = handler.handle.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({
      sessionId: "deus-session-1",
      seq: 1,
      event: { type: "turn.started", sessionId: "deus-session-1", turnId: "t1" },
    });
    expect(second.seq).toBe(2);
  });

  it("maps agnt session.error to the engine error event", () => {
    capturedOnFrame!({ type: "session.error", code: "sidecar_unreachable", message: "boom" });

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(handler.handle.mock.calls[0][0].event).toMatchObject({
      type: "error",
      category: "internal",
      message: "sidecar_unreachable: boom",
      recoverable: false,
    });
  });

  it("synthesizes the missed turn.ended from a snapshot's turns[] outcome", () => {
    handler.liveTurnId.mockReturnValue("turn-x");
    capturedOnFrame!({
      type: "session.snapshot",
      state: {
        currentTurnId: null,
        turns: [{ turnId: "turn-x", stopReason: "end_turn", cost: 0.01 }],
      },
    });

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(handler.handle.mock.calls[0][0].event).toMatchObject({
      type: "turn.ended",
      turnId: "turn-x",
      stopReason: "end_turn",
      cost: 0.01,
    });
  });

  it("fails the live turn when the sandbox dies mid-turn — after the recovery grace window", () => {
    // Real case: sidecar dies on a credential error → workspace 'stopped' —
    // without this the spinner hangs forever and the cause is an ephemeral
    // env line the user can miss entirely. The kill is GRACE-DELAYED: the
    // same stopped/error states pass by legitimately while a send is waking
    // a stopped sandbox, and recovery announces itself within seconds.
    vi.useFakeTimers();
    try {
      handler.liveTurnId.mockReturnValue("turn-x");
      capturedOnFrame!({
        type: "workspace.state",
        data: { status: "stopped", reason: "sidecar_disconnected (code=1006)" },
      });

      // Not yet — the grace window is still open.
      expect(handler.handle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20_000);

      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(handler.handle.mock.calls[0][0].event).toMatchObject({
        type: "turn.ended",
        turnId: "turn-x",
        stopReason: "error",
        error: {
          category: "internal",
          message: expect.stringContaining("sidecar_disconnected"),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("spares the queued turn when recovery follows the stop (wake-by-send)", () => {
    // A send into a STOPPED sandbox queues the turn server-side and triggers
    // reprovision — the stopped/error states seen on the way are NOT a death,
    // and killing the turn here is what produced the "Send again to restart
    // it" loop. Provisioning disarms the kill; the turn replays on the new
    // sandbox.
    vi.useFakeTimers();
    try {
      handler.liveTurnId.mockReturnValue("turn-x");
      capturedOnFrame!({ type: "workspace.state", data: { status: "stopped" } });
      capturedOnFrame!({ type: "workspace.state", data: { status: "provisioning" } });
      vi.advanceTimersByTime(60_000);

      expect(handler.handle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves settled sessions alone when the sandbox stops (no live turn)", () => {
    handler.liveTurnId.mockReturnValue(undefined);
    capturedOnFrame!({ type: "workspace.state", data: { status: "stopped" } });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it("ignores a snapshot while our live turn is still current server-side", () => {
    handler.liveTurnId.mockReturnValue("turn-x");
    capturedOnFrame!({ type: "session.snapshot", state: { currentTurnId: "turn-x", turns: [] } });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it("auto-allows permission requests over the socket (ClientCommand shape: data-nested)", () => {
    capturedOnFrame!({
      type: "permission.request",
      data: { requestId: "req-1", toolName: "Bash" },
    });

    expect(mockSend).toHaveBeenCalledWith({
      type: "permission.response",
      data: { requestId: "req-1", sessionId: "agnt-session-1", result: { behavior: "allow" } },
    });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it("relays the built-in AskUserQuestion (a permission request) through the overlay and answers in updatedInput", async () => {
    mockRelay.mockResolvedValueOnce({ answers: ["A"] });
    const input = {
      questions: [
        {
          question: "Which letter?",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    };
    capturedOnFrame!({
      type: "permission.request",
      data: { requestId: "req-q", toolName: "AskUserQuestion", input },
    });
    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "permission.response",
          data: expect.objectContaining({
            requestId: "req-q",
            result: {
              behavior: "allow",
              updatedInput: { ...input, answers: { "Which letter?": "A" } },
            },
          }),
        })
      )
    );
    // The overlay saw the question in the RPC handler's shape.
    expect(mockRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "askUserQuestion",
        params: {
          sessionId: "deus-session-1",
          questions: [{ question: "Which letter?", options: ["A", "B"], multiSelect: false }],
        },
      })
    );
  });

  it("denies a dismissed AskUserQuestion — the overlay's sentinel is not an answer", async () => {
    mockRelay.mockResolvedValueOnce({ answers: ["USER_CANCELLED"] });
    capturedOnFrame!({
      type: "permission.request",
      data: {
        requestId: "req-c",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which?", options: ["A"] }] },
      },
    });
    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "permission.response",
          data: expect.objectContaining({
            requestId: "req-c",
            result: { behavior: "deny", message: "The user dismissed the question" },
          }),
        })
      )
    );
  });

  it("delivers an answer given after the socket dropped by reconnecting, not by dropping it", async () => {
    let settle: (value: { answers: string[] }) => void = () => {};
    mockRelay.mockImplementationOnce(
      () =>
        new Promise<{ answers: string[] }>((resolve) => {
          settle = resolve;
        })
    );
    capturedOnFrame!({
      type: "permission.request",
      data: {
        requestId: "req-r",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which?", options: ["A"] }] },
      },
    });
    await vi.waitFor(() => expect(mockRelay).toHaveBeenCalled());

    // The socket goes down while the overlay waits: the driver forgets the
    // session and nothing reopens it until the next send.
    socketOpen = false;
    capturedOnDown!("read ECONNRESET");
    const connectsBefore = connectCount;
    socketOpen = true; // the reconnect the answer triggers comes up fine

    settle({ answers: ["A"] });
    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "permission.response",
          data: expect.objectContaining({
            requestId: "req-r",
            result: expect.objectContaining({ behavior: "allow" }),
          }),
        })
      )
    );
    expect(connectCount).toBe(connectsBefore + 1);
  });

  it("updates the workspace row from workspace.state frames", () => {
    capturedOnFrame!({ type: "workspace.state", data: { status: "running" } });
    expect(mockRun).toHaveBeenCalledWith("deus-ws-1");
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("broadcasts workspace.state as an ephemeral cloud:env q:event", () => {
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "provisioning", step: "cloning_repository" },
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const frame = JSON.parse(mockBroadcast.mock.calls[0][0] as string);
    expect(frame).toEqual({
      type: "q:event",
      event: "cloud:env",
      data: {
        workspaceId: "deus-ws-1",
        sessionId: "deus-session-1",
        data: { status: "provisioning", step: "cloning_repository" },
      },
    });
  });

  it("drops malformed workspace.state data at the broadcast seam", () => {
    mockBroadcast.mockClear();
    mockRun.mockClear();
    capturedOnFrame!({ type: "workspace.state", data: { step: 42 } });
    expect(mockBroadcast).not.toHaveBeenCalled();
    // The row update has its own tolerance and still runs.
    expect(mockRun).toHaveBeenCalled();
  });

  it("learns an asleep sandbox from the connect snapshot (row + chat line)", () => {
    // After a backend restart no workspace.state ever fires for an
    // already-paused VM — the snapshot's session status is the only truth.
    mockBroadcast.mockClear();
    mockRun.mockClear();
    capturedOnFrame!({ type: "session.snapshot", state: { status: "paused" } });
    expect(mockRun).toHaveBeenCalled();
    const frame = JSON.parse(mockBroadcast.mock.calls[0][0] as string);
    expect(frame.event).toBe("cloud:env");
    expect(frame.data.data).toEqual({ status: "paused" });
  });

  it("snapshot with an awake status refreshes the row silently", () => {
    mockBroadcast.mockClear();
    mockRun.mockClear();
    capturedOnFrame!({ type: "session.snapshot", state: { status: "ready" } });
    expect(mockRun).toHaveBeenCalled();
    // No "Environment ready" noise pushed at the chat on every reconnect.
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("cloud driver session lifecycle", () => {
  it("lazily creates the agnt session for a bare new-tab session row", async () => {
    // New chat tabs insert plain session rows with no provider twin — the
    // driver must create one on first cloud contact, not error out.
    const { getSessionRaw } = await import("../../../src/db");
    vi.mocked(getSessionRaw).mockReturnValueOnce({
      id: "deus-session-lazy",
      workspace_id: "deus-ws-1",
      provider_session_id: null,
    } as never);
    mockCreateSession.mockClear();
    mockRun.mockClear();
    await ensureCloudSession("deus-session-lazy");
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "agnt-ws-1", sessionId: "deus-session-lazy" })
    );
    // The created provider id is persisted onto the deus row.
    expect(mockRun).toHaveBeenCalledWith("agnt-lazy-1", "deus-session-lazy");
  });

  it("dedupes concurrent connects — a lost race would double-deliver frames", async () => {
    // Fresh driver state, then race two ensures for the same session: they
    // must share ONE socket connect (createSessionToken awaits, so the
    // check-then-connect window is real).
    shutdownCloudDriver();
    initCloudDriver(handler);
    connectCount = 0;
    const [a, b] = await Promise.all([
      ensureCloudSession("deus-session-1"),
      ensureCloudSession("deus-session-1"),
    ]);
    expect(a).toBe(b);
    expect(connectCount).toBe(1);
  });
});

describe("cloud driver turn API", () => {
  it("sends message.send with the deus turnId as both turn id and idempotency key", async () => {
    await startCloudTurn("deus-session-1", "turn-42", "hello", {});

    expect(handler.beginTurn).toHaveBeenCalledWith("deus-session-1", "turn-42");
    const frame = mockSend.mock.calls.at(-1)![0];
    expect(frame).toMatchObject({
      type: "message.send",
      text: "hello",
      turnId: "turn-42",
      idempotencyKey: "turn-42",
      options: { apiKey: "sk-ant-test" },
    });
  });

  it("rejects a send while a turn is live (agnt would queue, deus's contract is one turn)", async () => {
    handler.liveTurnId.mockReturnValue("busy-turn");
    await expect(startCloudTurn("deus-session-1", "turn-43", "hi", {})).rejects.toThrow(
      /still working/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("cloud driver diff channel", () => {
  it("correlates diff.response frames to the pending request", async () => {
    const pending = requestCloudDiff("deus-session-1", { scope: "SUMMARY" });
    // The send happens after the async ensure step — wait for the frame,
    // then echo its generated requestId back.
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
    const sent = mockSend.mock.calls.at(-1)![0] as { data: { requestId: string } };
    capturedOnFrame!({
      type: "diff.response",
      data: {
        scope: "SUMMARY",
        requestId: sent.data.requestId,
        files: [{ type: "MODIFY", path: "a.ts", additions: 3, deletions: 1 }],
      },
    });

    const result = await pending;
    expect(result.files).toEqual([{ type: "MODIFY", path: "a.ts", additions: 3, deletions: 1 }]);
  });

  it("rejects pending diffs when the socket goes down", async () => {
    const pending = requestCloudDiff("deus-session-1", { scope: "SUMMARY" });
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
    capturedOnDown!("gone");
    await expect(pending).rejects.toThrow(/gone/);
  });
});
