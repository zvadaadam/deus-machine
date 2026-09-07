import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { makeCloudFrameHandler } from "@/features/session/cloud/cloudFrameHandler";
import {
  createStreamCursor,
  flushDeltas,
  messagesKey,
  type AgentStreamContext,
  type SessionFold,
} from "@/features/session/lib/agentEventFold";
import type { PaginatedMessages } from "@/features/session/api/session.service";
import type { Session } from "@shared/types/session";

const T = 1_700_000_000_000;

function makeCtx(qc: QueryClient, sessionId: string): AgentStreamContext {
  const folds = new Map<string, SessionFold>();
  const cursor = createStreamCursor();
  return {
    queryClient: qc,
    activeSessionId: sessionId,
    folds,
    cursor,
    // Flush synchronously in the test (no requestAnimationFrame).
    scheduleFlush: () => {
      const fold = folds.get(sessionId);
      if (fold) flushDeltas(qc, sessionId, fold);
    },
    requestRefetch: () => {},
  };
}

/** Mac-closed mode has no HTTP page to fetch — start from an empty page (the
 *  hook seeds this before the socket opens). */
function seedEmptyPage(qc: QueryClient, sessionId: string) {
  qc.setQueryData<PaginatedMessages>(messagesKey(sessionId), {
    messages: [],
    compactions: [],
    has_older: false,
    has_newer: false,
  });
}

const textPart = (id: string, sessionId: string, messageId: string, text: string) => ({
  type: "text",
  id,
  sessionId,
  messageId,
  text,
  state: "done",
});

/** A minimal `Session` row for the by-workspace list cache. Defaults model the
 *  discovery heuristic: untitled ⇒ `message_count: 0` (would label "New chat"). */
function baseSession(id: string, workspaceId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspace_id: workspaceId,
    agent_harness: "claude-code",
    provider_session_id: id,
    workspace_kind: "cloud",
    title: null,
    status: "idle",
    message_count: 0,
    context_token_count: 0,
    context_used_percent: 0,
    is_hidden: false,
    last_user_message_at: null,
    updated_at: new Date(T).toISOString(),
    ...overrides,
  };
}

describe("makeCloudFrameHandler", () => {
  it("folds a live streamed turn into queryKeys.sessions.messages(sessionId)", () => {
    const SESSION = "sess-direct-live";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    const turn = "turn-1";
    (
      [
        {
          type: "session.created",
          sessionId: SESSION,
          nativeSessionId: "nat",
          harness: "claude-code",
          timestamp: T,
        },
        {
          type: "message.started",
          sessionId: SESSION,
          turnId: turn,
          messageId: "m1",
          outputIndex: 1,
          role: "assistant",
          timestamp: T,
        },
        {
          type: "message.part",
          sessionId: SESSION,
          turnId: turn,
          messageId: "m1",
          outputIndex: 1,
          partIndex: 0,
          part: textPart("p1", SESSION, "m1", "hello from cloud"),
          timestamp: T,
        },
        {
          type: "turn.ended",
          sessionId: SESSION,
          turnId: turn,
          stopReason: "end_turn",
          timestamp: T,
        },
      ] as Record<string, unknown>[]
    ).forEach(onFrame);

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION));
    expect(page).toBeDefined();
    expect(JSON.stringify(page!.messages)).toContain("hello from cloud");
  });

  it("backfills the prior transcript from session.snapshot.messages, then folds live", () => {
    const SESSION = "sess-direct-snap";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    // A reconnect/first-connect snapshot carrying two prior messages.
    onFrame({
      type: "session.snapshot",
      state: {
        sessionId: SESSION,
        organizationId: "org",
        workspaceId: "ws",
        status: "ready",
        currentTurnId: null,
        turns: [],
      },
      messages: [
        {
          id: "m1",
          messageIndex: 0,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 1,
          role: "user",
          createdAt: T,
          parts: [textPart("p1", SESSION, "m1", "prior user question")],
        },
        {
          id: "m2",
          messageIndex: 1,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 2,
          role: "assistant",
          createdAt: T,
          parts: [textPart("p2", SESSION, "m2", "prior assistant reply")],
        },
      ],
      events: [],
    } as Record<string, unknown>);

    // Then a live turn on top.
    (
      [
        {
          type: "message.started",
          sessionId: SESSION,
          turnId: "t2",
          messageId: "m3",
          outputIndex: 3,
          role: "assistant",
          timestamp: T,
        },
        {
          type: "message.part",
          sessionId: SESSION,
          turnId: "t2",
          messageId: "m3",
          outputIndex: 3,
          partIndex: 0,
          part: textPart("p3", SESSION, "m3", "live streamed answer"),
          timestamp: T,
        },
        {
          type: "turn.ended",
          sessionId: SESSION,
          turnId: "t2",
          stopReason: "end_turn",
          timestamp: T,
        },
      ] as Record<string, unknown>[]
    ).forEach(onFrame);

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION));
    expect(page).toBeDefined();
    const body = JSON.stringify(page!.messages);
    // Prior transcript (backfilled) AND the live turn, in the same cache.
    expect(body).toContain("prior user question");
    expect(body).toContain("prior assistant reply");
    expect(body).toContain("live streamed answer");
    expect(page!.messages.length).toBe(3);
  });

  it("renders with NO pre-seeded page (Mac-closed has no HTTP seed)", () => {
    const SESSION = "sess-direct-noseed";
    const qc = new QueryClient();
    // Deliberately DO NOT seedEmptyPage — this is the Mac-closed reality.
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    const turn = "turn-1";
    (
      [
        {
          type: "message.started",
          sessionId: SESSION,
          turnId: turn,
          messageId: "m1",
          outputIndex: 1,
          role: "assistant",
          timestamp: T,
        },
        {
          type: "message.part",
          sessionId: SESSION,
          turnId: turn,
          messageId: "m1",
          outputIndex: 1,
          partIndex: 0,
          part: textPart("p1", SESSION, "m1", "no seed needed"),
          timestamp: T,
        },
        {
          type: "turn.ended",
          sessionId: SESSION,
          turnId: turn,
          stopReason: "end_turn",
          timestamp: T,
        },
      ] as Record<string, unknown>[]
    ).forEach(onFrame);

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION));
    expect(page, "routeEnvelope must self-seed the page or the hook must").toBeDefined();
    expect(JSON.stringify(page?.messages ?? [])).toContain("no seed needed");
  });

  it("a reconnect (fresh handler, shared fold lane) re-folds idempotently, no refetch churn", () => {
    const SESSION = "sess-reconnect";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);

    // A shared fold lane (folds survive remounts, like the hook's).
    const folds = new Map<string, SessionFold>();
    const cursor = createStreamCursor();
    const requestRefetch = vi.fn();
    const ctx: AgentStreamContext = {
      queryClient: qc,
      activeSessionId: SESSION,
      folds,
      cursor,
      scheduleFlush: () => {
        const fold = folds.get(SESSION);
        if (fold) flushDeltas(qc, SESSION, fold);
      },
      requestRefetch,
    };

    const snapshot = {
      type: "session.snapshot",
      state: { sessionId: SESSION, status: "ready", currentTurnId: null, turns: [] },
      messages: [
        {
          id: "m1",
          messageIndex: 0,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 1,
          role: "user",
          createdAt: T,
          parts: [textPart("p1", SESSION, "m1", "the question")],
        },
        {
          id: "m2",
          messageIndex: 1,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 2,
          role: "assistant",
          createdAt: T,
          parts: [textPart("p2", SESSION, "m2", "the answer")],
        },
      ],
      events: [],
    } as Record<string, unknown>;

    // Connection 1.
    makeCloudFrameHandler(ctx, SESSION)(snapshot);
    expect(qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!.messages).toHaveLength(2);

    // Connection 2 = a remount: a FRESH handler over the same fold lane.
    requestRefetch.mockClear();
    makeCloudFrameHandler(ctx, SESSION)(snapshot);

    // Re-folding the same snapshot is upsert-by-id — no duplicates, and with no
    // wire seq there is no cursor to reset, so no refetch churn.
    expect(qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!.messages).toHaveLength(2);
    expect(requestRefetch).not.toHaveBeenCalled();
  });

  it("orders a late snapshot's history BEFORE an optimistic bubble, stamping has_older:false", () => {
    // The user sent (optimistic bubble in the page) and THEN the snapshot
    // arrived — the fold appends the reconstructed history, so without the
    // ordering commit the transcript would read prompt-then-its-own-history.
    const SESSION = "sess-order";
    const qc = new QueryClient();
    qc.setQueryData<PaginatedMessages>(messagesKey(SESSION), {
      messages: [
        {
          id: "optimistic-1",
          session_id: SESSION,
          seq: 0,
          role: "user",
          turn_id: "t2",
          sent_at: new Date(T).toISOString(),
          parts: [textPart("po", SESSION, "optimistic-1", "my new question")],
        },
      ],
      compactions: [],
      has_older: true, // deliberately wrong — the commit must flip it to false
      has_newer: false,
    } as PaginatedMessages);
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    onFrame({
      type: "session.snapshot",
      state: { sessionId: SESSION, status: "ready", currentTurnId: null, turns: [] },
      messages: [
        {
          id: "m1",
          messageIndex: 0,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 1,
          role: "user",
          createdAt: T,
          parts: [textPart("p1", SESSION, "m1", "prior question")],
        },
        {
          id: "m2",
          messageIndex: 1,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 2,
          role: "assistant",
          createdAt: T,
          parts: [textPart("p2", SESSION, "m2", "prior answer")],
        },
      ],
      events: [],
    } as Record<string, unknown>);

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!;
    // Snapshot rows lead in messageIndex order; the optimistic bubble trails.
    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2", "optimistic-1"]);
    // The snapshot IS the whole transcript — nothing earlier to page to.
    expect(page.has_older).toBe(false);
  });

  it("unrolls a snapshot's state.compactions into the page's compactions list", () => {
    const SESSION = "sess-snap-compaction";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    onFrame({
      type: "session.snapshot",
      state: {
        sessionId: SESSION,
        status: "ready",
        currentTurnId: null,
        turns: [],
        compactions: [
          {
            compactionId: "c1",
            turnId: "t1",
            status: "completed",
            trigger: "auto",
            preTokens: 100_000,
            postTokens: 20_000,
            summary: "summarized the context",
            timestamp: T,
          },
        ],
      },
      messages: [
        {
          id: "m1",
          messageIndex: 0,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 1,
          role: "user",
          createdAt: T,
          parts: [textPart("p1", SESSION, "m1", "a question")],
        },
      ],
      events: [],
    } as Record<string, unknown>);

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!;
    expect(page.compactions).toHaveLength(1);
    expect(page.compactions[0]).toMatchObject({
      compaction_id: "c1",
      session_id: SESSION,
      turn_id: "t1",
      status: "completed",
      trigger: "auto",
      pre_tokens: 100_000,
      post_tokens: 20_000,
      summary: "summarized the context",
      created_at: new Date(T).toISOString(),
    });
  });

  it("projects a LIVE session.compaction into the page (not just a refetch)", () => {
    const SESSION = "sess-live-compaction";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const requestRefetch = vi.fn();
    const ctx = { ...makeCtx(qc, SESSION), requestRefetch };
    const onFrame = makeCloudFrameHandler(ctx, SESSION);

    onFrame({
      type: "session.compaction",
      sessionId: SESSION,
      turnId: "t1",
      compactionId: "c1",
      status: "completed",
      trigger: "auto",
      preTokens: 90_000,
      summary: "done",
      timestamp: T,
    });

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!;
    // The direct lane has no backend to page from, so the divider MUST be
    // projected inline — the refetch fires too (Mac lane), but is not what makes
    // the divider appear here.
    expect(page.compactions).toHaveLength(1);
    expect(page.compactions[0]).toMatchObject({ compaction_id: "c1", status: "completed" });
    expect(requestRefetch).toHaveBeenCalled();
  });

  it("merges repeated session.compaction upserts by id (status replaces, fields COALESCE, created_at anchors)", () => {
    const SESSION = "sess-compaction-merge";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    // "started, 90k in" — no summary yet.
    onFrame({
      type: "session.compaction",
      sessionId: SESSION,
      turnId: "t1",
      compactionId: "c1",
      status: "in_progress",
      trigger: "auto",
      preTokens: 90_000,
      timestamp: T,
    });
    // "done, here's the summary" — a LATER stamp, no preTokens restated.
    onFrame({
      type: "session.compaction",
      sessionId: SESSION,
      turnId: "t1",
      compactionId: "c1",
      status: "completed",
      summary: "the summary",
      postTokens: 15_000,
      timestamp: T + 5_000,
    });

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!;
    expect(page.compactions).toHaveLength(1);
    expect(page.compactions[0]).toMatchObject({
      compaction_id: "c1",
      status: "completed", // replaced
      pre_tokens: 90_000, // kept from the first (second omitted it)
      post_tokens: 15_000, // added by the second
      summary: "the summary", // added by the second
      created_at: new Date(T).toISOString(), // ANCHORED to the first event
    });
  });

  it("projects the turn lifecycle onto sessions.detail (web-direct has no q: push)", () => {
    const SESSION = "sess-status";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    // The detail row exists (discovery wrote it); the projection merge-patches it.
    qc.setQueryData(["sessions", "detail", SESSION], {
      id: SESSION,
      status: "idle",
      message_count: 0,
    });
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    onFrame({ type: "turn.started", sessionId: SESSION, turnId: "t1", timestamp: T });
    expect(qc.getQueryData<{ status: string }>(["sessions", "detail", SESSION])!.status).toBe(
      "working"
    );

    onFrame({
      type: "turn.ended",
      sessionId: SESSION,
      turnId: "t1",
      stopReason: "end_turn",
      timestamp: T,
    });
    expect(qc.getQueryData<{ status: string }>(["sessions", "detail", SESSION])!.status).toBe(
      "idle"
    );

    onFrame({
      type: "turn.ended",
      sessionId: SESSION,
      turnId: "t2",
      stopReason: "error",
      error: { category: "network", message: "boom" },
      timestamp: T,
    });
    expect(qc.getQueryData<{ status: string }>(["sessions", "detail", SESSION])!.status).toBe(
      "error"
    );

    // `stopReason: "error"` with NO inline error object is a valid terminal
    // shape (the backend classifies it as an internal error) — still an error.
    onFrame({ type: "turn.started", sessionId: SESSION, turnId: "t3", timestamp: T });
    onFrame({
      type: "turn.ended",
      sessionId: SESSION,
      turnId: "t3",
      stopReason: "error",
      timestamp: T,
    });
    expect(qc.getQueryData<{ status: string }>(["sessions", "detail", SESSION])!.status).toBe(
      "error"
    );
  });

  it("projects session.usage onto the context gauge (count always, percent needs a size)", () => {
    const SESSION = "sess-usage";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    qc.setQueryData(["sessions", "detail", SESSION], {
      id: SESSION,
      status: "idle",
      context_token_count: 0,
      context_used_percent: 12,
    });
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    // Size known → both fields move.
    onFrame({
      type: "session.usage",
      sessionId: SESSION,
      turnId: "t",
      used: 50_000,
      size: 200_000,
      timestamp: T,
    });
    let d = qc.getQueryData<{ context_token_count: number; context_used_percent: number }>([
      "sessions",
      "detail",
      SESSION,
    ])!;
    expect(d.context_token_count).toBe(50_000);
    expect(d.context_used_percent).toBe(25);

    // Size unknown → count moves, percent KEEPS its prior value (the Mac
    // backend's COALESCE semantics, mirrored).
    onFrame({ type: "session.usage", sessionId: SESSION, turnId: "t", used: 60_000, timestamp: T });
    d = qc.getQueryData<{ context_token_count: number; context_used_percent: number }>([
      "sessions",
      "detail",
      SESSION,
    ])!;
    expect(d.context_token_count).toBe(60_000);
    expect(d.context_used_percent).toBe(25);
  });

  it("snapshot restates session facts: live turn → working, real message_count", () => {
    const SESSION = "sess-snap-facts";
    const WORKSPACE = "ws-snap-facts";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    // Discovery wrote both caches — detail, and the chat-tab bar's by-workspace
    // list — with the title-based heuristic (`message_count: 0` for an
    // untitled but started session). The snapshot must fix BOTH, not just the
    // detail: the chat-tab list reads only `sessions.by-workspace`, and a
    // snapshot that leaves it on 0 mislabels a started conversation "New chat".
    qc.setQueryData(["sessions", "detail", SESSION], {
      id: SESSION,
      status: "idle",
      message_count: 0,
    });
    qc.setQueryData<Session[]>(
      ["sessions", "by-workspace", WORKSPACE],
      [{ ...baseSession(SESSION, WORKSPACE), message_count: 0, status: "idle", title: null }]
    );
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    onFrame({
      type: "session.snapshot",
      state: { sessionId: SESSION, status: "running", currentTurnId: "t-live", turns: [] },
      messages: [
        {
          id: "m1",
          messageIndex: 0,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 1,
          role: "user",
          createdAt: T,
          parts: [textPart("p1", SESSION, "m1", "q")],
        },
        {
          id: "m2",
          messageIndex: 1,
          sessionId: SESSION,
          turnId: "t1",
          outputIndex: 2,
          role: "assistant",
          createdAt: T,
          parts: [textPart("p2", SESSION, "m2", "a")],
        },
      ],
      events: [],
    } as Record<string, unknown>);

    const detail = qc.getQueryData<{ status: string; message_count: number }>([
      "sessions",
      "detail",
      SESSION,
    ])!;
    // A live turn in the snapshot means working NOW; count fixes discovery's zero.
    expect(detail.status).toBe("working");
    expect(detail.message_count).toBe(2);

    // The chat-tab list cache MUST be patched too — the bug was that only the
    // detail cache was, leaving the chat-tab label "New chat" while the
    // transcript rendered.
    const list = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE])!;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(SESSION);
    expect(list[0].message_count).toBe(2);
  });

  it("seeds the live turn as ACTIVE from a snapshot (the one-live-turn send guard reads it)", () => {
    const SESSION = "sess-direct-liveturn";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const ctx = makeCtx(qc, SESSION);
    const onFrame = makeCloudFrameHandler(ctx, SESSION);

    // Mid-turn reconnect: the engine is working but hasn't emitted a message
    // yet — the snapshot restates no `turn.started`, so without the synthesized
    // seed the reducer would hold no active turn and an overlapping send would
    // pass the guard.
    const snapshot = {
      type: "session.snapshot",
      state: {
        sessionId: SESSION,
        organizationId: "org",
        workspaceId: "ws",
        status: "ready",
        currentTurnId: "t-live",
        turns: [],
      },
      messages: [],
    };
    onFrame(snapshot);

    const turns = ctx.folds.get(SESSION)?.state.turns ?? [];
    expect(turns.some((t) => t.turnId === "t-live" && t.status === "active")).toBe(true);

    // Idempotent on a second snapshot (replay overlap no-ops in the reducer).
    onFrame(snapshot);
    const again = ctx.folds.get(SESSION)?.state.turns ?? [];
    expect(again.filter((t) => t.turnId === "t-live")).toHaveLength(1);
  });

  it("folds category-bearing engine errors onto their turn; the turn still closes", () => {
    const SESSION = "sess-direct-engine-error";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const ctx = makeCtx(qc, SESSION);
    const onFrame = makeCloudFrameHandler(ctx, SESSION);

    onFrame({ type: "turn.started", sessionId: SESSION, turnId: "t1", timestamp: T });
    // The engine's error EVENT (category-bearing) — distinct from a channel
    // command rejection (category-less), which the socket hook consumes.
    onFrame({
      type: "error",
      sessionId: SESSION,
      turnId: "t1",
      category: "overloaded",
      message: "provider overloaded",
      recoverable: true,
      timestamp: T,
    });

    const turn = ctx.folds.get(SESSION)?.state.turns.find((t) => t.turnId === "t1");
    expect(turn?.errors).toHaveLength(1);
    expect(turn?.status).toBe("active"); // an error record alone must not end the turn

    onFrame({
      type: "turn.ended",
      sessionId: SESSION,
      turnId: "t1",
      stopReason: "end",
      timestamp: T,
    });
    const ended = ctx.folds.get(SESSION)?.state.turns.find((t) => t.turnId === "t1");
    expect(ended?.status).toBe("ended"); // …so a later send passes the one-live-turn guard
  });

  it("ignores non-render frames (workspace.state, pty.data, …)", () => {
    const SESSION = "sess-direct-noise";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

    onFrame({ type: "workspace.state", data: { status: "ready" } });
    onFrame({ type: "pty.data", data: { id: "t", data: [1, 2] } });
    onFrame({ type: "fs.response", data: {} });

    const page = qc.getQueryData<PaginatedMessages>(messagesKey(SESSION));
    expect(page!.messages).toHaveLength(0);
  });

  describe("snapshot restates message_count onto sessions.by-workspace (chat-tab list)", () => {
    /** A two-message snapshot used by the tests below. Carries the
     *  already-folded transcript as `messages`, exactly as agnt does. */
    function twoMessageSnapshot(sessionId: string) {
      return {
        type: "session.snapshot",
        state: { sessionId, status: "ready", currentTurnId: null, turns: [] },
        messages: [
          {
            id: "m1",
            messageIndex: 0,
            sessionId,
            turnId: "t1",
            outputIndex: 1,
            role: "user",
            createdAt: T,
            parts: [textPart("p1", sessionId, "m1", "the question")],
          },
          {
            id: "m2",
            messageIndex: 1,
            sessionId,
            turnId: "t1",
            outputIndex: 2,
            role: "assistant",
            createdAt: T,
            parts: [textPart("p2", sessionId, "m2", "the answer")],
          },
        ],
        events: [],
      } as Record<string, unknown>;
    }

    it("a started-but-untitled session's chat-tab list row is corrected to the real count", () => {
      // The regression scenario: discovery mapped the row through `toSession`
      // with `title: null` ⇒ `message_count: 0` (the heuristic). Without this
      // patch, the chat-tab bar hydrates ONCE from the heuristic and labels a
      // started session "New chat" while the transcript renders below it.
      const SESSION = "sess-tab-facts";
      const WORKSPACE = "ws-tab-facts";
      const qc = new QueryClient();
      seedEmptyPage(qc, SESSION);
      qc.setQueryData<Session[]>(
        ["sessions", "by-workspace", WORKSPACE],
        [
          baseSession(SESSION, WORKSPACE), // message_count: 0 (the heuristic)
        ]
      );
      const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

      onFrame(twoMessageSnapshot(SESSION));

      const list = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE])!;
      expect(list).toHaveLength(1);
      expect(list[0].message_count).toBe(2); // the snapshot's real count replaces the heuristic
    });

    it("only the matching session's row moves; sibling sessions keep their counts", () => {
      // A by-workspace list typically holds multiple sessions (one per
      // sandbox under the workspace). The patch must scope to the snapshot's
      // own session id and leave siblings exactly where they were — both the
      // started (so their "Claude #N" numbering does not drift) and the not
      // started (so a different session's "New chat" label is not stolen by
      // this snapshot's count).
      const TARGET = "sess-tab-target";
      const SIBLING_STARTED = "sess-tab-sibling-started";
      const SIBLING_NEW = "sess-tab-sibling-new";
      const WORKSPACE = "ws-tab-mixed";
      const qc = new QueryClient();
      seedEmptyPage(qc, TARGET);
      qc.setQueryData<Session[]>(
        ["sessions", "by-workspace", WORKSPACE],
        [
          baseSession(TARGET, WORKSPACE, { message_count: 0 }), // heuristic 0 (untitled)
          baseSession(SIBLING_STARTED, WORKSPACE, { message_count: 1, title: "fix the bug" }),
          baseSession(SIBLING_NEW, WORKSPACE, { message_count: 0 }),
        ]
      );
      const onFrame = makeCloudFrameHandler(makeCtx(qc, TARGET), TARGET);

      onFrame(twoMessageSnapshot(TARGET));

      const list = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE])!;
      const counts = Object.fromEntries(list.map((s) => [s.id, s.message_count]));
      expect(counts).toEqual({
        [TARGET]: 2, // patched — the snapshot's real count
        [SIBLING_STARTED]: 1, // untouched
        [SIBLING_NEW]: 0, // untouched
      });
    });

    it("walks every `sessions.by-workspace` key, not just the session's own workspace", () => {
      // `patchWorkspaceSessionStatus` walks every `["workspaces","by-repo"]`
      // key so a row moves under whichever filter the sidebar has active; the
      // chat-tab list patch must do the same for `["sessions","by-workspace"]`,
      // because the same session's row can be cached under different cache
      // keys (e.g. an admin/all-workspaces projection), and only one of them
      // is the live hydration source.
      const SESSION = "sess-tab-multi";
      const WORKSPACE_A = "ws-tab-multi-a";
      const WORKSPACE_B = "ws-tab-multi-b";
      const qc = new QueryClient();
      seedEmptyPage(qc, SESSION);
      qc.setQueryData<Session[]>(
        ["sessions", "by-workspace", WORKSPACE_A],
        [baseSession(SESSION, WORKSPACE_A, { message_count: 0 })]
      );
      qc.setQueryData<Session[]>(
        ["sessions", "by-workspace", WORKSPACE_B],
        [baseSession(SESSION, WORKSPACE_B, { message_count: 0 })]
      );
      const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

      onFrame(twoMessageSnapshot(SESSION));

      const listA = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE_A])!;
      const listB = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE_B])!;
      expect(listA[0].message_count).toBe(2);
      expect(listB[0].message_count).toBe(2);
    });

    it("leaves an absent by-workspace list absent (discovery owns creation)", () => {
      // The patch is a merge-patch mirror of `patchSessionDetail`'s "leave an
      // uncached row absent" — it must NOT mint a single-element list from
      // nothing, because that would bypass discovery's mapping (missing
      // workspace_id, agent_harness, etc.) and would race a later discovery
      // fetch that then nulls the count back to the heuristic.
      const SESSION = "sess-tab-absent";
      const WORKSPACE = "ws-tab-absent";
      const qc = new QueryClient();
      seedEmptyPage(qc, SESSION);
      const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

      onFrame(twoMessageSnapshot(SESSION));

      // No list was seeded; the patch must leave the cache empty (not invent
      // a one-row list from the snapshot alone).
      const list = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE]);
      expect(list).toBeUndefined();
    });

    it("a second snapshot re-patches the by-workspace list with the new count (reconnect)", () => {
      // agnt sends a fresh snapshot on every (re)connect; the count grows as
      // the conversation does, so the patch must move with it — not pin the
      // count from the first snapshot. Idempotent: re-applying the same count
      // is a no-op, applying a larger count updates the cache.
      const SESSION = "sess-tab-repatch";
      const WORKSPACE = "ws-tab-repatch";
      const qc = new QueryClient();
      seedEmptyPage(qc, SESSION);
      qc.setQueryData<Session[]>(
        ["sessions", "by-workspace", WORKSPACE],
        [baseSession(SESSION, WORKSPACE, { message_count: 0 })]
      );
      const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

      onFrame(twoMessageSnapshot(SESSION));
      expect(
        qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE])![0].message_count
      ).toBe(2);

      // Reconnect sends a snapshot with one MORE message in the transcript.
      onFrame({
        type: "session.snapshot",
        state: { sessionId: SESSION, status: "ready", currentTurnId: null, turns: [] },
        messages: [
          {
            id: "m1",
            messageIndex: 0,
            sessionId: SESSION,
            turnId: "t1",
            outputIndex: 1,
            role: "user",
            createdAt: T,
            parts: [textPart("p1", SESSION, "m1", "the question")],
          },
          {
            id: "m2",
            messageIndex: 1,
            sessionId: SESSION,
            turnId: "t1",
            outputIndex: 2,
            role: "assistant",
            createdAt: T,
            parts: [textPart("p2", SESSION, "m2", "the answer")],
          },
          {
            id: "m3",
            messageIndex: 2,
            sessionId: SESSION,
            turnId: "t2",
            outputIndex: 1,
            role: "user",
            createdAt: T,
            parts: [textPart("p3", SESSION, "m3", "a follow-up question")],
          },
        ],
        events: [],
      } as Record<string, unknown>);

      expect(
        qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE])![0].message_count
      ).toBe(3);
    });

    it("titled sessions keep their `message_count: 1` heuristic replaced by the real count", () => {
      // A titled session's heuristic is `1`, but the real count from the
      // snapshot is the truth; the patch must replace even the heuristic-1
      // with the snapshot's authoritative count so the chat-tab `#N` number
      // and the header agree, and so `computeSequences` (which counts only
      // `message_count > 0` rows) doesn't double-number siblings when the
      // heuristic underran the real count.
      const SESSION = "sess-tab-titled";
      const WORKSPACE = "ws-tab-titled";
      const qc = new QueryClient();
      seedEmptyPage(qc, SESSION);
      qc.setQueryData<Session[]>(
        ["sessions", "by-workspace", WORKSPACE],
        [baseSession(SESSION, WORKSPACE, { message_count: 1, title: "Fix the bug" })]
      );
      const onFrame = makeCloudFrameHandler(makeCtx(qc, SESSION), SESSION);

      onFrame(twoMessageSnapshot(SESSION));

      const list = qc.getQueryData<Session[]>(["sessions", "by-workspace", WORKSPACE])!;
      expect(list[0].message_count).toBe(2); // replaced the heuristic-1, not kept
    });
  });
});
