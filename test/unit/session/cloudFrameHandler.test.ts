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

  it("a reconnect (fresh handler + persistent seq) re-backfills idempotently, no reset churn", () => {
    const SESSION = "sess-reconnect";
    const qc = new QueryClient();
    seedEmptyPage(qc, SESSION);

    // A shared fold lane (folds + cursor survive remounts, like the hook's).
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

    // The hook's persistent per-session seq, lifetime-matched to the cursor.
    const seqCounters = new Map<string, number>();
    const nextSeq = () => {
      const n = (seqCounters.get(SESSION) ?? 0) + 1;
      seqCounters.set(SESSION, n);
      return n;
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
    makeCloudFrameHandler(ctx, SESSION, nextSeq)(snapshot);
    expect(qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!.messages).toHaveLength(2);

    // Connection 2 = a remount: a FRESH handler, same ctx, same persistent seq.
    requestRefetch.mockClear();
    makeCloudFrameHandler(ctx, SESSION, nextSeq)(snapshot);

    // No duplicates (upsert-by-id) and NO forced reset → no refetch churn.
    expect(qc.getQueryData<PaginatedMessages>(messagesKey(SESSION))!.messages).toHaveLength(2);
    expect(requestRefetch).not.toHaveBeenCalled();
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
