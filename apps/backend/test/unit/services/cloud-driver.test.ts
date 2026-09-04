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
let capturedOnOpen: (() => void) | null = null;
let connectCount = 0;
/** Toggled by the reconnect tests: a closed socket reads false. */
let socketOpen = true;

vi.mock("../../../src/services/agent/cloud/session-socket", () => ({
  connectSessionSocket: (options: {
    onFrame: (frame: Record<string, unknown>) => void;
    onOpen?: () => void;
    onDown?: (reason: string) => void;
  }) => {
    connectCount += 1;
    capturedOnFrame = options.onFrame;
    capturedOnOpen = options.onOpen ?? null;
    capturedOnDown = options.onDown ?? null;
    return {
      ready: () => Promise.resolve(),
      send: mockSend,
      isOpen: () => socketOpen,
      close: mockClose,
    };
  },
}));

let identityChanged: (() => void) | null = null;
vi.mock("../../../src/services/agent/cloud/config", () => ({
  setCloudIdentityChangedHandler: (fn: () => void) => {
    identityChanged = fn;
  },
  getCloudConfig: () => ({
    baseUrl: "http://agnt.test",
    apiKey: "agnt_sk_test_x",
    anthropicApiKey: "sk-ant-test",
    claudeOauthToken: null,
  }),
}));

const mockCreateSession = vi.fn(async (_opts: Record<string, unknown>) => ({ id: "agnt-lazy-1" }));
const mockCreateSessionToken = vi.fn(async () => ({ token: "session-jwt" }));
const mockGetSession = vi.fn(async (..._args: unknown[]) => ({ simulator: null }) as unknown);
vi.mock("@deus-hq/sdk", () => ({
  createSessionToken: () => mockCreateSessionToken(),
  createSession: (opts: Record<string, unknown>) => mockCreateSession(opts),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockRelay = vi.fn(async (..._args: unknown[]) => ({ answers: ["yes"] }));
const mockCancelSessionRelays = vi.fn((..._args: unknown[]) => [] as string[]);
vi.mock("../../../src/services/agent/tool-relay", () => ({
  relay: (...args: unknown[]) => mockRelay(...args),
  cancelSessionRelays: (...args: unknown[]) => mockCancelSessionRelays(...args),
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
const mockPrepare = vi.fn((_sql: string) => ({ run: mockRun, get: mockGet }));
vi.mock("../../../src/lib/database", () => ({
  getDatabase: () => ({ prepare: mockPrepare }),
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
  pushCloudSessionFacts,
  startCloudSimulator,
  stopCloudSimulator,
  execCloudSimulator,
  parseCloudSimulatorPlatform,
  getCloudSimulatorStatus,
  readCloudPreviewTemplate,
} from "../../../src/services/agent/cloud/driver";
import { getCloudPreviewTemplate } from "../../../src/services/agent/cloud/preview";

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

  it("queues an answer while the socket is between retries and delivers it when it reopens", async () => {
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
        requestId: "req-o",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which?", options: ["A"] }] },
      },
    });
    await vi.waitFor(() => expect(mockRelay).toHaveBeenCalled());

    // Not open, not down: the socket is retrying in the background (an
    // outage longer than ready()'s deadline looks exactly like this).
    socketOpen = false;
    settle({ answers: ["A"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "permission.response" })
    );

    socketOpen = true;
    capturedOnOpen!();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission.response",
        data: expect.objectContaining({ requestId: "req-o" }),
      })
    );
  });

  it("carries queued answers across a socket replacement and a terminal drop", async () => {
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
        requestId: "req-x",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which?", options: ["A"] }] },
      },
    });
    await vi.waitFor(() => expect(mockRelay).toHaveBeenCalled());

    // Answer lands between retries: queued on the current session.
    socketOpen = false;
    settle({ answers: ["A"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "permission.response" })
    );

    // That socket gives up (terminal onDown) — the queue must not die with it.
    capturedOnDown!("session socket down after 8 retries");
    // The first reconnect attempt fails at the token mint: the queue must
    // survive that too (it is only handed over once a session is registered).
    mockCreateSessionToken.mockRejectedValueOnce(new Error("mint failed"));
    await expect(ensureCloudSession("deus-session-1")).rejects.toThrow("mint failed");
    // The next caller reconnects: the replacement inherits the queue and its
    // onOpen delivers it.
    socketOpen = true;
    await ensureCloudSession("deus-session-1");
    capturedOnOpen!();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission.response",
        data: expect.objectContaining({ requestId: "req-x" }),
      })
    );
  });

  it("keeps an answer submitted AFTER a terminal drop when the reconnect's setup fails", async () => {
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
        requestId: "req-late",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which?", options: ["A"] }] },
      },
    });
    await vi.waitFor(() => expect(mockRelay).toHaveBeenCalled());

    // The socket gives up before the user answers; the answer's own reconnect
    // then fails at the token mint.
    socketOpen = false;
    capturedOnDown!("session socket down after 8 retries");
    mockCreateSessionToken.mockRejectedValueOnce(new Error("mint failed"));
    settle({ answers: ["A"] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "permission.response" })
    );

    // The next connect delivers it.
    socketOpen = true;
    await ensureCloudSession("deus-session-1");
    capturedOnOpen!();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission.response",
        data: expect.objectContaining({ requestId: "req-late" }),
      })
    );
  });

  it("serializes metadata pushes per provider session — a slow default stamp cannot land after the first-send restamp", async () => {
    // Only OUR two pushes are held back; the scaffolding's connect-time stamps
    // (queued on the same chain by beforeEach) settle at once.
    const held: Array<{ body: string; resolve: () => void }> = [];
    const fetchMock = vi.fn(
      (_url: string, init?: { body?: string }) =>
        new Promise<Response>((resolve) => {
          const body = String(init?.body);
          const done = () => resolve(new Response("{}", { status: 200 }));
          if (body.includes("claude-code") || body.includes("codex-app-server")) {
            held.push({ body, resolve: done });
          } else {
            done();
          }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    mockGet.mockReturnValueOnce({ kind: "cloud", provider_session_id: "agnt-session-1" } as never);
    mockGet.mockReturnValueOnce({ kind: "cloud", provider_session_id: "agnt-session-1" } as never);
    try {
      pushCloudSessionFacts("deus-session-1", { harness: "claude-code" });
      pushCloudSessionFacts("deus-session-1", { harness: "codex-app-server" });

      await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 5000 });
      expect(held[0].body).toContain("claude-code");
      // The second waits for the first to settle.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(held).toHaveLength(1);

      held[0].resolve();
      await vi.waitFor(() => expect(held).toHaveLength(2));
      expect(held[1].body).toContain("codex-app-server");
      held[1].resolve();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settles the session's pending relays when its turn ends (a stopped turn's question is retracted)", () => {
    capturedOnFrame!({
      type: "turn.ended",
      sessionId: "agnt-session-1",
      turnId: "t1",
      stopReason: "cancelled",
    });
    expect(mockCancelSessionRelays).toHaveBeenCalledWith("deus-session-1", "turn ended");
    // The lifecycle event itself still reaches the fold.
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it("updates the workspace row from workspace.state frames", () => {
    capturedOnFrame!({ type: "workspace.state", data: { status: "running" } });
    expect(mockRun).toHaveBeenCalledWith("deus-ws-1");
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("remembers the sandbox's public host template in memory (running state + snapshot) and announces it", () => {
    mockPrepare.mockClear();
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "running", sandboxUrlTemplate: "https://{{port}}-sb123.e2b.app" },
    });
    expect(getCloudPreviewTemplate("deus-ws-1")).toBe("https://{{port}}-sb123.e2b.app");
    // The template is a capability URL: it never touches the row.
    expect(mockPrepare).not.toHaveBeenCalledWith(expect.stringContaining("cloud_preview"));
    const previews = () =>
      mockBroadcast.mock.calls
        .map((c) => JSON.parse(c[0] as string))
        .filter((e) => e.event === "cloud:preview");
    expect(previews()).toEqual([
      {
        type: "q:event",
        event: "cloud:preview",
        data: {
          workspaceId: "deus-ws-1",
          sessionId: "deus-session-1",
          template: "https://{{port}}-sb123.e2b.app",
        },
      },
    ]);

    // A reconnect snapshot repeating the value is not re-announced; a new
    // sandbox (reprovision) is.
    capturedOnFrame!({
      type: "session.snapshot",
      state: { status: "ready", sandboxUrlTemplate: "https://{{port}}-sb123.e2b.app", turns: [] },
      messages: [],
    });
    expect(previews()).toHaveLength(1);
    capturedOnFrame!({
      type: "session.snapshot",
      state: { status: "ready", sandboxUrlTemplate: "https://{{port}}-sb456.e2b.app", turns: [] },
      messages: [],
    });
    expect(getCloudPreviewTemplate("deus-ws-1")).toBe("https://{{port}}-sb456.e2b.app");
    expect(previews()).toHaveLength(2);
  });

  it("drops the host template when the platform reports none (no sandbox behind the session)", () => {
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "running", sandboxUrlTemplate: "https://{{port}}-sb1.e2b.app" },
    });
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "running", sandboxUrlTemplate: null },
    });
    expect(getCloudPreviewTemplate("deus-ws-1")).toBeNull();
    expect(JSON.parse(mockBroadcast.mock.calls[0][0] as string)).toMatchObject({
      event: "cloud:preview",
      data: { template: null },
    });

    // Absent (an older platform, or a state that never carries it): untouched.
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "running", sandboxUrlTemplate: "https://{{port}}-sb2.e2b.app" },
    });
    capturedOnFrame!({ type: "workspace.state", data: { status: "provisioning" } });
    expect(getCloudPreviewTemplate("deus-ws-1")).toBe("https://{{port}}-sb2.e2b.app");
  });

  it("forgets every host template when the platform identity changes — they were account A's computers", () => {
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "running", sandboxUrlTemplate: "https://{{port}}-sbA.e2b.app" },
    });
    mockPrepare.mockClear();
    identityChanged!();
    // Never told again — not "no sandbox" (null): the read must re-seed.
    expect(getCloudPreviewTemplate("deus-ws-1")).toBeUndefined();
    // No cloud capability URL lives on a row any more: nothing to clear there.
    expect(mockPrepare).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE workspaces"));
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

describe("cloud driver preview template read", () => {
  it("answers undefined and opens the workspace's session when the template was never told", async () => {
    shutdownCloudDriver();
    initCloudDriver(handler);
    connectCount = 0;
    currentSessionRow();
    expect(readCloudPreviewTemplate("deus-ws-1")).toBeUndefined();
    await vi.waitFor(() => expect(connectCount).toBe(1));
  });

  it("answers null for a platform-reported 'no sandbox' without touching the socket", async () => {
    await ensureCloudSession("deus-session-1");
    connectCount = 0;
    capturedOnFrame!({
      type: "workspace.state",
      data: { status: "running", sandboxUrlTemplate: null },
    });
    expect(readCloudPreviewTemplate("deus-ws-1")).toBeNull();
    expect(connectCount).toBe(0);
  });
});

/** The workspace → current-session lookup behind the preview read. */
function currentSessionRow() {
  mockGet.mockReturnValueOnce({ kind: "cloud", session_id: "deus-session-1" } as never);
}

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

describe("cloud driver simulator channel", () => {
  const T = "2026-09-03T10:00:00.000Z";
  /** The workspace → current-session lookup behind every device command. */
  const currentSession = () =>
    mockGet.mockReturnValueOnce({ kind: "cloud", session_id: "deus-session-1" } as never);

  it("remembers a simulator.status frame in memory and broadcasts it — nothing lands on the row", async () => {
    mockPrepare.mockClear();
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      easSessionIdentifier: "eas-1",
      streamUrl: "https://stream.expo.dev/eas-1",
      timestamp: T,
    });

    // The platform is the truth; the driver keeps a cache, not a column.
    expect(mockPrepare).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE workspaces"));
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toEqual({
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      easSessionIdentifier: "eas-1",
      streamUrl: "https://stream.expo.dev/eas-1",
      timestamp: T,
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockBroadcast.mock.calls[0][0] as string)).toEqual({
      type: "q:event",
      event: "cloud:simulator",
      data: {
        workspaceId: "deus-ws-1",
        sessionId: "deus-session-1",
        kind: "status",
        // The platform payload minus `type` — its sessionId is agnt's.
        data: {
          sessionId: "agnt-session-1",
          status: "ready",
          platform: "ios",
          easSessionIdentifier: "eas-1",
          streamUrl: "https://stream.expo.dev/eas-1",
          timestamp: T,
        },
      },
    });
  });

  it("never keeps a stream URL past a terminal status, whatever the frame says", async () => {
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/stale",
      timestamp: T,
    });
    const status = await getCloudSimulatorStatus("deus-ws-1");
    expect(status).toMatchObject({ status: "stopped", platform: "ios" });
    expect(status).not.toHaveProperty("streamUrl");
    // The broadcast carries the same normalized shape the cache holds.
    const event = JSON.parse(mockBroadcast.mock.calls[0][0] as string);
    expect(event.data.data).not.toHaveProperty("streamUrl");
  });

  it("keeps the platform's error text on an error status — no platform means a sidecar failure, not a device", async () => {
    const error =
      "This sandbox's sidecar predates simulator control — restart the workspace to upgrade it.";
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "error",
      error,
      timestamp: T,
    });
    const status = await getCloudSimulatorStatus("deus-ws-1");
    expect(status).toMatchObject({ status: "error", error });
    expect(status).not.toHaveProperty("platform");
  });

  it("learns the device from the connect snapshot's latestSimulatorStatus", async () => {
    // After a backend restart no simulator.status fires for a device that is
    // already running (and billing) — the snapshot mirror is the only truth.
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "session.snapshot",
      state: {
        status: "ready",
        turns: [],
        latestSimulatorStatus: {
          type: "simulator.status",
          sessionId: "agnt-session-1",
          status: "ready",
          platform: "android",
          streamUrl: "https://stream.expo.dev/eas-2",
          timestamp: T,
        },
      },
      messages: [],
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      platform: "android",
      streamUrl: "https://stream.expo.dev/eas-2",
    });
    const events = mockBroadcast.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "cloud:simulator",
        data: expect.objectContaining({
          kind: "status",
          data: expect.objectContaining({ status: "ready", platform: "android" }),
        }),
      })
    );
  });

  it("marks the device stopped when the sandbox parks — the platform's settle frame may ride a socket that is down", async () => {
    // Each boot after a park is a later platform frame (a replay of the
    // pre-park frame would rightly be refused — see the park-replay test).
    let tick = 0;
    const ready = () =>
      capturedOnFrame!({
        type: "simulator.status",
        sessionId: "agnt-session-1",
        status: "ready",
        platform: "ios",
        streamUrl: "https://stream.expo.dev/live",
        timestamp: new Date(Date.parse(T) + ++tick * 1000).toISOString(),
      });
    for (const status of ["stopped", "paused", "error"]) {
      ready();
      mockBroadcast.mockClear();
      capturedOnFrame!({ type: "workspace.state", data: { status } });
      // The park is announced (clients drop the URL) and cached.
      const events = mockBroadcast.mock.calls.map((c) => JSON.parse(c[0] as string));
      const parked = events.find((e) => e.event === "cloud:simulator");
      expect(parked?.data?.data).toMatchObject({ status: "stopped", platform: "ios" });
      expect(parked?.data?.data).not.toHaveProperty("streamUrl");
      const cached = await getCloudSimulatorStatus("deus-ws-1");
      expect(cached).toMatchObject({ status: "stopped" });
      expect(cached).not.toHaveProperty("streamUrl");
    }
    // A live sandbox leaves the device alone.
    ready();
    mockBroadcast.mockClear();
    capturedOnFrame!({ type: "workspace.state", data: { status: "running" } });
    expect(mockBroadcast.mock.calls.map((c) => JSON.parse(c[0] as string))).not.toContainEqual(
      expect.objectContaining({ event: "cloud:simulator" })
    );
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({ status: "ready" });
  });

  it("stays silent about a workspace no device was ever known for when its sandbox parks", () => {
    mockBroadcast.mockClear();
    capturedOnFrame!({ type: "workspace.state", data: { status: "stopped" } });
    expect(mockBroadcast.mock.calls.map((c) => JSON.parse(c[0] as string))).not.toContainEqual(
      expect.objectContaining({ event: "cloud:simulator" })
    );
  });

  it("lets a parked sandbox override a stale device status in the same snapshot", async () => {
    // The snapshot mirror can be older than the sandbox's own state (an older
    // platform that never settled it): the device cannot outlive its sandbox.
    capturedOnFrame!({
      type: "session.snapshot",
      state: {
        status: "stopped",
        turns: [],
        latestSimulatorStatus: {
          type: "simulator.status",
          sessionId: "agnt-session-1",
          status: "ready",
          platform: "ios",
          streamUrl: "https://stream.expo.dev/stale",
          timestamp: T,
        },
      },
      messages: [],
    });
    const status = await getCloudSimulatorStatus("deus-ws-1");
    expect(status).toMatchObject({ status: "stopped" });
    expect(status).not.toHaveProperty("streamUrl");
  });

  it("forgets every device on identity change — a stream URL is account-scoped", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/a",
      timestamp: T,
    });
    mockBroadcast.mockClear();
    identityChanged!();
    // The clients hold the same account-scoped caches: one broadcast tells
    // every store to start over.
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"event":"cloud:identity"'));
    expect(JSON.parse(mockBroadcast.mock.calls[0][0] as string).data.generation).toEqual(
      expect.any(Number)
    );
    // Nothing cached and (the default row mock names no provider session) no
    // REST read either: unknown.
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("drops a stale status copy — agnt fans each transition to every session socket, and the copies can interleave", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
      timestamp: "2026-09-03T10:00:05.000Z",
    });
    mockBroadcast.mockClear();
    // A delayed copy of the earlier `starting` from another socket: older
    // than what the cache holds — dropped, not broadcast; the stream URL and
    // the ready state survive.
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "starting",
      platform: "ios",
      timestamp: "2026-09-03T10:00:01.000Z",
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      streamUrl: "https://stream.expo.dev/live",
    });
    // A genuinely newer transition still applies.
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "ios",
      timestamp: "2026-09-03T10:00:09.000Z",
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "stopped",
    });
  });

  it("keeps a running ios device in front when the android one stops — the other platform's transition says nothing", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
      timestamp: "2026-09-03T10:00:05.000Z",
    });
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "android",
      timestamp: "2026-09-03T10:00:06.000Z",
    });
    // The tab still shows the running ios device: no broadcast, same read.
    expect(mockBroadcast).not.toHaveBeenCalled();
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
    });
  });

  it("hands the tab to the other platform's device only once the primary is gone", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
      timestamp: "2026-09-03T10:00:05.000Z",
    });
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "starting",
      platform: "android",
      timestamp: "2026-09-03T10:00:06.000Z",
    });
    // A booting android beside a running ios: ios stays in front.
    expect(mockBroadcast).not.toHaveBeenCalled();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "ios",
      timestamp: "2026-09-03T10:00:07.000Z",
    });
    // Now the android device is the workspace's device — the clients hear it.
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockBroadcast.mock.calls[0][0] as string).data.data).toMatchObject({
      status: "starting",
      platform: "android",
    });
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "starting",
      platform: "android",
    });
  });

  it("relays a screenshot the platform fanned out to two sockets once", () => {
    const shot = {
      type: "simulator.screenshot",
      sessionId: "agnt-session-1",
      platform: "ios",
      imageBase64: "AAAA",
      format: "png",
      timestamp: "2026-09-03T10:00:08.000Z",
    };
    mockBroadcast.mockClear();
    capturedOnFrame!(shot);
    capturedOnFrame!(shot); // the second session socket's copy
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    // A genuinely new capture still goes through.
    capturedOnFrame!({ ...shot, timestamp: "2026-09-03T10:00:09.000Z" });
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
  });

  it("drops a frame from a socket the identity change closed — account A's device never lands under B", async () => {
    const deliver = capturedOnFrame!;
    identityChanged!();
    mockBroadcast.mockClear();
    deliver({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/account-a",
      timestamp: "2026-09-03T10:00:05.000Z",
    });
    expect(mockBroadcast.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("account-a")
    );
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
  });

  it("refuses the pre-park state coming back on another socket — same timestamp, dead stream", async () => {
    const ready = {
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
      timestamp: "2026-09-03T10:00:05.000Z",
    };
    capturedOnFrame!(ready);
    mockBroadcast.mockClear();
    capturedOnFrame!({ type: "workspace.state", data: { status: "paused" } });
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"status":"stopped"'));
    mockBroadcast.mockClear();
    // The other session socket's late copy of the very last platform frame.
    capturedOnFrame!(ready);
    expect(mockBroadcast).not.toHaveBeenCalled();
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "stopped",
    });
    // A genuinely later boot applies.
    capturedOnFrame!({ ...ready, status: "starting", timestamp: "2026-09-03T10:00:09.000Z" });
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "starting",
      streamUrl: "https://stream.expo.dev/live",
    });
  });

  it("keeps a status that landed on the socket while the REST read was in flight", async () => {
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);
    let answer!: (value: unknown) => void;
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const read = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
      timestamp: "2026-09-03T10:00:09.000Z",
    });
    // Computed before the frame: older, must not win.
    answer({
      simulator: {
        session_id: "agnt-session-1",
        status: "starting",
        platform: "ios",
        timestamp: "2026-09-03T10:00:01.000Z",
      },
    });
    await expect(read).resolves.toMatchObject({
      status: "ready",
      streamUrl: "https://stream.expo.dev/live",
    });
  });

  it("does not let a stale 'no device' REST answer erase a status that landed meanwhile", async () => {
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);
    let answer!: (value: unknown) => void;
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const read = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "starting",
      platform: "android",
      timestamp: "2026-09-03T10:00:09.000Z",
    });
    answer({ simulator: null });
    await expect(read).resolves.toMatchObject({ status: "starting", platform: "android" });
    currentSession();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "starting",
    });
  });

  it("discards a REST answer that started under the previous identity — account A's device must not land under B", async () => {
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);
    let answer!: (value: unknown) => void;
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const read = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    mockBroadcast.mockClear();
    identityChanged!();
    answer({
      simulator: {
        session_id: "agnt-session-1",
        status: "ready",
        platform: "ios",
        stream_url: "https://stream.expo.dev/account-a",
        timestamp: T,
      },
    });
    await expect(read).resolves.toBeNull();
    expect(mockBroadcast.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("account-a")
    );
    // Nothing cached: the next read asks the platform again.
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);
    mockGetSession.mockResolvedValueOnce({ simulator: null });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
    expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it("refuses a timestamp-less replay after a park — only a frame that proves it is newer restarts the device", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
      timestamp: "2026-09-03T10:00:05.000Z",
    });
    capturedOnFrame!({ type: "workspace.state", data: { status: "paused" } });
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
    currentSession();
    const status = await getCloudSimulatorStatus("deus-ws-1");
    expect(status).toMatchObject({ status: "stopped" });
    expect(status).not.toHaveProperty("streamUrl");
  });

  it("keeps a park against the REST mirror of the pre-park frame, and takes a later boot from it", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
      timestamp: "2026-09-03T10:00:05.000Z",
    });
    capturedOnFrame!({ type: "workspace.state", data: { status: "paused" } });
    socketOpen = false;
    try {
      const row = () =>
        mockGet.mockReturnValueOnce({
          kind: "cloud",
          session_id: "deus-session-1",
          provider_session_id: "agnt-session-1",
        } as never);
      row();
      mockGetSession.mockResolvedValueOnce({
        simulator: {
          session_id: "agnt-session-1",
          status: "ready",
          platform: "ios",
          stream_url: "https://stream.expo.dev/live",
          timestamp: "2026-09-03T10:00:05.000Z",
        },
      });
      mockBroadcast.mockClear();
      const parked = await getCloudSimulatorStatus("deus-ws-1");
      expect(parked).toMatchObject({ status: "stopped" });
      expect(parked).not.toHaveProperty("streamUrl");
      expect(mockBroadcast).not.toHaveBeenCalled();
      row();
      mockGetSession.mockResolvedValueOnce({
        simulator: {
          session_id: "agnt-session-1",
          status: "starting",
          platform: "ios",
          timestamp: "2026-09-03T10:00:09.000Z",
        },
      });
      await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
        status: "starting",
      });
      // The replacement reached every client, not just the requester.
      expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"status":"starting"'));
    } finally {
      socketOpen = true;
    }
  });

  it("broadcasts what a REST read changed, and a gone when the platform knows of no device any more", async () => {
    socketOpen = false;
    try {
      const row = () =>
        mockGet.mockReturnValueOnce({
          kind: "cloud",
          session_id: "deus-session-1",
          provider_session_id: "agnt-session-1",
        } as never);
      row();
      mockGetSession.mockResolvedValueOnce({
        simulator: {
          session_id: "agnt-session-1",
          status: "starting",
          platform: "ios",
          timestamp: T,
        },
      });
      mockBroadcast.mockClear();
      await getCloudSimulatorStatus("deus-ws-1");
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockBroadcast.mock.calls[0][0] as string)).toMatchObject({
        event: "cloud:simulator",
        data: { workspaceId: "deus-ws-1", kind: "status", data: { status: "starting" } },
      });
      // Same answer again: nothing to tell.
      row();
      mockGetSession.mockResolvedValueOnce({
        simulator: {
          session_id: "agnt-session-1",
          status: "starting",
          platform: "ios",
          timestamp: T,
        },
      });
      mockBroadcast.mockClear();
      await getCloudSimulatorStatus("deus-ws-1");
      expect(mockBroadcast).not.toHaveBeenCalled();
      // The device is gone from the platform: every client drops it.
      row();
      mockGetSession.mockResolvedValueOnce({ simulator: null });
      await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
      expect(JSON.parse(mockBroadcast.mock.calls[0][0] as string)).toMatchObject({
        event: "cloud:simulator",
        data: { workspaceId: "deus-ws-1", kind: "gone" },
      });
    } finally {
      socketOpen = true;
    }
  });

  it("reads the status through an older provisioned chat when the current one has no platform session yet", async () => {
    // A fresh chat next to a running device: its own provider_session_id is
    // null, but the device belongs to the workspace's sandbox, which the
    // older chat's platform session reports just as well.
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-2",
      provider_session_id: null,
    } as never);
    mockGet.mockReturnValueOnce({ provider_session_id: "agnt-session-old" } as never);
    mockGetSession.mockResolvedValueOnce({
      simulator: {
        session_id: "agnt-session-old",
        status: "ready",
        platform: "android",
        stream_url: "https://stream.expo.dev/old",
        timestamp: T,
      },
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      platform: "android",
      streamUrl: "https://stream.expo.dev/old",
    });
    expect(mockGetSession).toHaveBeenCalledWith("agnt-session-old", expect.anything());
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("provider_session_id IS NOT NULL")
    );
  });

  it("answers the platform's REST status when nothing was seen on a socket yet, then serves the cache", async () => {
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);
    mockGetSession.mockResolvedValueOnce({
      simulator: {
        session_id: "agnt-session-1",
        status: "ready",
        platform: "ios",
        eas_session_identifier: "eas-9",
        stream_url: "https://stream.expo.dev/rest",
        timestamp: T,
      },
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toEqual({
      status: "ready",
      platform: "ios",
      easSessionIdentifier: "eas-9",
      streamUrl: "https://stream.expo.dev/rest",
      timestamp: T,
    });
    expect(mockGetSession).toHaveBeenCalledWith(
      "agnt-session-1",
      // Bounded: a stalled platform connection must not pin the request.
      expect.objectContaining({ baseUrl: "http://agnt.test", signal: expect.any(AbortSignal) })
    );
    await getCloudSimulatorStatus("deus-ws-1");
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it("answers null when the platform knows of no device", async () => {
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);
    mockGetSession.mockResolvedValueOnce({ simulator: null });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
  });

  it("broadcasts screenshots and action results without touching the row (live-only by design)", () => {
    mockRun.mockClear();
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.screenshot",
      sessionId: "agnt-session-1",
      platform: "ios",
      imageBase64: "iVBORw0KGgo=",
      format: "png",
      timestamp: T,
    });
    capturedOnFrame!({
      type: "simulator.action_result",
      sessionId: "agnt-session-1",
      platform: "ios",
      verb: "press",
      args: ["ref-3"],
      success: true,
      output: "pressed ref-3",
      timestamp: T,
    });

    expect(mockRun).not.toHaveBeenCalled();
    const events = mockBroadcast.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(events.map((e) => e.data.kind)).toEqual(["screenshot", "action_result"]);
    expect(events[0].data.data).toEqual({
      sessionId: "agnt-session-1",
      platform: "ios",
      imageBase64: "iVBORw0KGgo=",
      format: "png",
      timestamp: T,
    });
    expect(events[1].data.data).toMatchObject({ verb: "press", success: true });
  });

  it("drops a malformed simulator frame at the seam, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mockRun.mockClear();
      mockBroadcast.mockClear();
      capturedOnFrame!({ type: "simulator.status", sessionId: "agnt-session-1", status: 7 });
      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("simulator"));
    } finally {
      warn.mockRestore();
    }
  });

  it("sends simulator.start / simulator.stop on the workspace's current session channel", async () => {
    currentSession();
    await startCloudSimulator("deus-ws-1", "ios");
    expect(mockSend).toHaveBeenLastCalledWith({
      type: "simulator.start",
      data: { platform: "ios" },
    });

    // Omitted platform = the workspace default (start) / every device (stop).
    currentSession();
    await stopCloudSimulator("deus-ws-1");
    expect(mockSend).toHaveBeenLastCalledWith({ type: "simulator.stop", data: {} });
  });

  it("refuses device commands outside cloud workspaces", async () => {
    mockGet.mockReturnValueOnce({
      kind: "worktree",
      current_session_id: "deus-session-1",
    } as never);
    await expect(startCloudSimulator("deus-ws-local")).rejects.toThrow(/cloud workspaces/);
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: "simulator.start" }));
  });

  it("narrows the platform param and rejects anything but ios/android", () => {
    expect(parseCloudSimulatorPlatform(undefined)).toBeUndefined();
    expect(parseCloudSimulatorPlatform("android")).toBe("android");
    expect(() => parseCloudSimulatorPlatform("visionos")).toThrow(/ios|android/);
  });

  it("resolves an exec by requestId with the platform's verdict verbatim — a failed verb is a result, not an exception", async () => {
    currentSession();
    const pending = execCloudSimulator("deus-ws-1", { verb: "press", args: ["ref-9"] });
    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: "simulator.exec.request" })
      )
    );
    const sent = mockSend.mock.calls.at(-1)![0] as { data: Record<string, unknown> };
    expect(sent.data).toEqual({ requestId: expect.any(String), verb: "press", args: ["ref-9"] });

    // The response is FLAT (no `data` wrapper), unlike diff/fs.
    capturedOnFrame!({
      type: "simulator.exec.response",
      sessionId: "agnt-session-1",
      requestId: sent.data.requestId,
      verb: "press",
      success: false,
      exitCode: 1,
      output: "",
      error: "no element ref-9",
      timestamp: T,
    });
    await expect(pending).resolves.toEqual({
      success: false,
      exitCode: 1,
      output: "",
      error: "no element ref-9",
      // The platform's stamp rides along: a screenshot request correlates on it.
      timestamp: T,
    });
  });

  it("times out an unanswered exec after 60 s", async () => {
    vi.useFakeTimers();
    try {
      currentSession();
      const pending = execCloudSimulator("deus-ws-1", { verb: "appstate" });
      await vi.waitFor(() =>
        expect(mockSend).toHaveBeenCalledWith(
          expect.objectContaining({ type: "simulator.exec.request" })
        )
      );
      // Attach the expectation BEFORE the clock fires: the rejection lands on
      // the fake clock's macrotask, and a handler added afterwards would leave
      // it flagged as unhandled.
      const outcome = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an oversized exec before touching the socket", async () => {
    // The platform would answer an invalid request with a channel error the
    // pending map cannot correlate — the caller would wait out the timeout.
    await expect(
      execCloudSimulator("deus-ws-1", { verb: "fill", args: Array.from({ length: 9 }, () => "x") })
    ).rejects.toThrow(/at most 8/);
    await expect(execCloudSimulator("deus-ws-1", { verb: "   " })).rejects.toThrow(/verb/);
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "simulator.exec.request" })
    );
  });
});

describe("cloud simulator cache — round six (every platform, ordered REST, registry gap)", () => {
  const T1 = "2026-09-03T10:00:00.000Z";
  const T2 = "2026-09-03T10:05:00.000Z";
  const row = () =>
    mockGet.mockReturnValueOnce({
      kind: "cloud",
      session_id: "deus-session-1",
      provider_session_id: "agnt-session-1",
    } as never);

  it("rehydrates every mirrored platform from the snapshot — a later android stopped must not hide a live ios device", async () => {
    capturedOnFrame!({
      type: "session.snapshot",
      state: {
        status: "ready",
        turns: [],
        // The newest frame alone (what a pre-mirror platform sends) …
        latestSimulatorStatus: {
          type: "simulator.status",
          sessionId: "agnt-session-1",
          status: "stopped",
          platform: "android",
          timestamp: T2,
        },
        // … and every platform's last status.
        latestSimulatorStatuses: [
          {
            type: "simulator.status",
            sessionId: "agnt-session-1",
            status: "ready",
            platform: "ios",
            streamUrl: "https://stream.expo.dev/ios",
            timestamp: T1,
          },
          {
            type: "simulator.status",
            sessionId: "agnt-session-1",
            status: "stopped",
            platform: "android",
            timestamp: T2,
          },
        ],
      },
      messages: [],
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
    });
  });

  it("reads every platform from a REST detail that mirrors them, not just the newest", async () => {
    row();
    mockGetSession.mockResolvedValueOnce({
      simulator: {
        session_id: "agnt-session-1",
        status: "stopped",
        platform: "android",
        timestamp: T2,
      },
      simulators: [
        {
          session_id: "agnt-session-1",
          status: "ready",
          platform: "ios",
          stream_url: "https://stream.expo.dev/ios",
          timestamp: T1,
        },
        { session_id: "agnt-session-1", status: "stopped", platform: "android", timestamp: T2 },
      ],
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
    });
  });

  it("does not let an older REST answer repopulate a device a later REST answer declared gone", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/live",
      timestamp: T1,
    });
    socketOpen = false; // no live socket: the cache is only a hint, REST is consulted
    let answerA!: (value: unknown) => void;
    let answerB!: (value: unknown) => void;
    row();
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    const a = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    row();
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answerB = resolve)));
    const b = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    // The later read answers first: the platform knows of no device.
    answerB({ simulator: null });
    await expect(b).resolves.toBeNull();
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"gone"'));
    mockBroadcast.mockClear();
    // The earlier read's stale `ready` lands afterwards — it must not win.
    answerA({
      simulator: {
        session_id: "agnt-session-1",
        status: "ready",
        platform: "ios",
        stream_url: "https://stream.expo.dev/live",
        timestamp: T1,
      },
    });
    await expect(a).resolves.toBeNull();
    expect(mockBroadcast).not.toHaveBeenCalledWith(expect.stringContaining('"kind":"status"'));
    socketOpen = true;
  });

  it("reopens the workspace's session when a status read finds no live socket, and leaves a live one alone", async () => {
    // Live socket (the beforeEach connected it): a read is just a read.
    connectCount = 0;
    row();
    await getCloudSimulatorStatus("deus-ws-1");
    expect(connectCount).toBe(0);
    // No socket (this backend restarted): the REST answer is what it is, but
    // the next transition must have a channel to arrive on — nothing else
    // reopens it on mobile, where the Simulator tab may be the only reader.
    shutdownCloudDriver();
    initCloudDriver(handler);
    connectCount = 0;
    row();
    await getCloudSimulatorStatus("deus-ws-1");
    await vi.waitFor(() => expect(connectCount).toBe(1));
  });

  it("lets a REST read issued later clear a device an earlier-issued read reported meanwhile", async () => {
    socketOpen = false;
    let answerA!: (value: unknown) => void;
    let answerB!: (value: unknown) => void;
    row();
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    const a = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    row();
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answerB = resolve)));
    const b = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    // The earlier read answers first: a live device.
    answerA({
      simulator: {
        session_id: "agnt-session-1",
        status: "ready",
        platform: "ios",
        stream_url: "https://stream.expo.dev/live",
        timestamp: T1,
      },
    });
    await expect(a).resolves.toMatchObject({ status: "ready" });
    mockBroadcast.mockClear();
    // The later read asked later and saw the device gone: it wins.
    answerB({ simulator: null });
    await expect(b).resolves.toBeNull();
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"gone"'));
    socketOpen = true;
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
  });

  it("prunes a cached platform the per-platform REST list no longer names", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
      timestamp: T1,
    });
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "android",
      timestamp: T2,
    });
    socketOpen = false;
    row();
    // The platform's complete list: android only — the ios device is gone.
    mockGetSession.mockResolvedValueOnce({
      simulator: {
        session_id: "agnt-session-1",
        status: "stopped",
        platform: "android",
        timestamp: T2,
      },
      simulators: [
        { session_id: "agnt-session-1", status: "stopped", platform: "android", timestamp: T2 },
      ],
    });
    mockBroadcast.mockClear();
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "stopped",
      platform: "android",
    });
    // The primary changed (ready ios → stopped android): every client hears it.
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"status"'));
    // The single-status shape of an older platform prunes nothing.
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios-2",
      timestamp: T2,
    });
    row();
    mockGetSession.mockResolvedValueOnce({
      simulator: {
        session_id: "agnt-session-1",
        status: "stopped",
        platform: "android",
        timestamp: T2,
      },
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "ready",
      platform: "ios",
    });
    socketOpen = true;
  });

  it("lets a later complete REST list prune what an earlier-issued read rewrote meanwhile", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
      timestamp: T1,
    });
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "android",
      timestamp: T1,
    });
    socketOpen = false;
    let answerA!: (value: unknown) => void;
    let answerB!: (value: unknown) => void;
    row();
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    const a = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    row();
    mockGetSession.mockReturnValueOnce(new Promise((resolve) => (answerB = resolve)));
    const b = getCloudSimulatorStatus("deus-ws-1");
    await Promise.resolve();
    // The earlier read answers first and rewrites both entries (newer stamps).
    answerA({
      simulators: [
        {
          session_id: "agnt-session-1",
          status: "ready",
          platform: "ios",
          stream_url: "https://stream.expo.dev/ios",
          timestamp: T2,
        },
        { session_id: "agnt-session-1", status: "stopped", platform: "android", timestamp: T2 },
      ],
    });
    await expect(a).resolves.toMatchObject({ status: "ready", platform: "ios" });
    mockBroadcast.mockClear();
    // The later read's complete list no longer names ios: it is gone, and the
    // earlier read's rewrite must not shield it the way a socket frame would.
    answerB({
      simulators: [
        { session_id: "agnt-session-1", status: "stopped", platform: "android", timestamp: T2 },
      ],
    });
    await expect(b).resolves.toMatchObject({ status: "stopped", platform: "android" });
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"status"'));
    socketOpen = true;
  });

  it("drops a platformless error once a device speaks — it must not outrank the device's later stopped", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "error",
      error: "SIDECAR_NOT_CONNECTED: sandbox is not connected — retry when running",
      timestamp: T1,
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({ status: "error" });
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "starting",
      platform: "ios",
      timestamp: T2,
    });
    mockBroadcast.mockClear();
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "ios",
      timestamp: "2026-09-03T10:10:00.000Z",
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "stopped",
      platform: "ios",
    });
    const last = JSON.parse(mockBroadcast.mock.calls.at(-1)![0] as string);
    expect(last.data.data).toMatchObject({ status: "stopped", platform: "ios" });
  });

  it("reconciles the cache against a reconnect snapshot's complete list — this session's omitted platform is gone", async () => {
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/ios",
      timestamp: T1,
    });
    capturedOnFrame!({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "stopped",
      platform: "android",
      timestamp: T1,
    });
    mockBroadcast.mockClear();
    // The socket reconnects; the ios device was removed meanwhile.
    capturedOnFrame!({
      type: "session.snapshot",
      state: {
        status: "ready",
        turns: [],
        latestSimulatorStatuses: [
          {
            type: "simulator.status",
            sessionId: "agnt-session-1",
            status: "stopped",
            platform: "android",
            timestamp: T1,
          },
        ],
      },
      messages: [],
    });
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toMatchObject({
      status: "stopped",
      platform: "android",
    });
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"status"'));
    // An empty list: everything this session spoke for is gone.
    capturedOnFrame!({
      type: "session.snapshot",
      state: { status: "ready", turns: [], latestSimulatorStatuses: [] },
      messages: [],
    });
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"gone"'));
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
  });

  it("forwards a newer identical status — the platform answering a retry the same way", async () => {
    const error = {
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "error",
      platform: "ios",
      error: "EAS GraphQL error: device quota exhausted",
    };
    capturedOnFrame!({ ...error, timestamp: T1 });
    mockBroadcast.mockClear();
    // A replay of the same frame (the snapshot mirror): silent.
    capturedOnFrame!({ ...error, timestamp: T1 });
    expect(mockBroadcast).not.toHaveBeenCalled();
    // The retry failed the same way, later: the clients must hear it (the
    // renderer clears "Booting the device" on any status event).
    capturedOnFrame!({ ...error, timestamp: T2 });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith(expect.stringContaining('"kind":"status"'));
  });

  it("drops a frame from a replaced channel that arrives while nothing is registered for the session", async () => {
    const oldOnFrame = capturedOnFrame!;
    socketOpen = false; // the old socket is not open: the next ensure replaces it
    let release!: (value: { token: string }) => void;
    mockCreateSessionToken.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const next = ensureCloudSession("deus-session-1");
    await Promise.resolve();
    await Promise.resolve();
    // Past `sessions.delete`, parked on the token mint: the registry is empty.
    mockBroadcast.mockClear();
    oldOnFrame({
      type: "simulator.status",
      sessionId: "agnt-session-1",
      status: "ready",
      platform: "ios",
      streamUrl: "https://stream.expo.dev/stale",
      timestamp: T1,
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
    socketOpen = true;
    release({ token: "session-jwt" });
    await next;
    // Nothing from the discarded channel reached the cache.
    await expect(getCloudSimulatorStatus("deus-ws-1")).resolves.toBeNull();
  });
});
