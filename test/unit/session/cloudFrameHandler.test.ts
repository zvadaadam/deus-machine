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
  });

  it("snapshot restates session facts: live turn → working, real message_count", () => {
    const SESSION = "sess-snap-facts";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);
    qc.setQueryData(["sessions", "detail", SESSION], {
      id: SESSION,
      status: "idle",
      message_count: 0,
    });
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
});
