import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createReasoningPart,
  createSteerEchoParts,
  createTextPart,
  createUserEchoParts,
  echoMessageId,
  steerMessageId,
} from "@zvada/agent-server/protocol/factories";
import { describe, expect, it, vi } from "vitest";
import { foldEvent, messagesKey } from "@/features/session/lib/agentEventFold";
import { queryKeys } from "@/shared/api/queryKeys";
import { Chat } from "@/features/session/ui/Chat";
import { SessionProvider } from "@/features/session/context";
import type { SessionStatus } from "@shared/enums";
import type { LifecycleEvent, Part, ReportedOrigin } from "@shared/protocol-types";
import type { Message, PaginatedMessages, SessionTurn } from "@shared/types/session";

const scroll = vi.hoisted(() => vi.fn());
const virtualization = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-virtual")>();
  return {
    ...original,
    useVirtualizer: (options: Parameters<typeof original.useVirtualizer>[0]) =>
      original.useVirtualizer({ ...options, initialRect: virtualization(options) }),
  };
});
vi.mock("@/features/session/hooks/useAutoScroll", () => ({
  useAutoScroll: (options: unknown) => ({
    showScrollButton: !!scroll(options),
    handleScrollToBottomClick: () => {},
    transcriptRef: () => {},
    liveTailRef: () => {},
    syncScrollPosition: () => {},
  }),
}));

const messages: Message[] = [
  {
    id: "message-1",
    session_id: "session-1",
    turn_id: "turn-1",
    seq: 0,
    role: "user",
    sent_at: "2026-09-09T10:00:00.000Z",
  },
];

it("keeps a deferred reply visible when the next turn starts in an Agent messages chat", () => {
  const client = new QueryClient();
  const a = { turnId: "turn-1", startedAt: 1 };
  const b = { turnId: "turn-2", startedAt: 3 };
  function reply(turnId: string, seq: number, text: string): Message {
    const ctx = { sessionId: "session-1", messageId: `${turnId}-reply` };
    return {
      ...messages[0],
      id: ctx.messageId,
      turn_id: turnId,
      role: "assistant",
      seq,
      parts: [createReasoningPart(ctx, "Checking", false), createTextPart(ctx, text, false)],
    };
  }
  const first = [...messages, reply(a.turnId, 1, "Answer from A.")];
  const next = [
    ...first,
    { ...messages[0], id: "prompt-b", turn_id: b.turnId, seq: 2 },
    reply(b.turnId, 3, "Answer from B."),
  ];

  // Replay the inputs on one Chat hook state in the static renderer.
  function Handoff({ through }: { through: number }) {
    const [step, advance] = useState(0);
    if (step < through) advance(step + 1);
    return Chat({
      loading: false,
      agentMessages: true,
      sessionStatus: step === 1 ? "idle" : "working",
      messages: step === 2 ? next : first,
      turns: step === 0 ? [a] : [{ ...a, endedAt: 2 }, ...(step === 2 ? [b] : [])],
    });
  }
  const render = (through: number) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, {
          sessionStatus: through === 1 ? "idle" : "working",
          subagentMessages: new Map(),
          children: createElement(Handoff, { through }),
        })
      )
    );
  try {
    virtualization.mockReturnValue({ width: 800, height: 900 });
    scroll.mockReturnValue(true);
    expect(render(0)).not.toContain("Answer from A.");
    const idle = render(1);
    expect(idle).toContain("Answer from A.");
    expect(idle).not.toContain("activity, Worked");
    const started = render(2);
    expect(started).toContain("Answer from A.");
    expect(started).not.toContain("activity, Worked");
    expect(started).not.toContain("Answer from B.");
  } finally {
    scroll.mockReset();
    virtualization.mockReset();
    client.clear();
  }
});

it("folds a read steer between replies and finishes the same turn once", () => {
  const client = new QueryClient();
  const sessionId = "chat";
  const turnId = "turn";
  const ctx = {
    queryClient: client,
    activeSessionId: sessionId,
    folds: new Map(),
    requestRefetch: vi.fn(),
    scheduleFlush: vi.fn(),
  };
  const feed = (event: LifecycleEvent) => foldEvent(ctx, sessionId, event);
  const stamp = { sessionId, turnId, timestamp: 1000 };
  function message(
    role: "user" | "assistant",
    outputIndex: number,
    messageId: string,
    part: Part,
    origin?: ReportedOrigin
  ) {
    const address = { ...stamp, messageId, outputIndex, timestamp: stamp.timestamp + outputIndex };
    feed({ type: "message.started", role, origin, ...address });
    feed({
      type: "message.part",
      ...address,
      partIndex: 0,
      part: { ...part, sessionId, messageId },
    });
    feed({ type: "message.ended", ...address });
  }
  function render(sessionStatus: SessionStatus, agentMessages = false) {
    const page = client.getQueryData<PaginatedMessages>(messagesKey(sessionId))!;
    expect(page.turns.map((turn) => turn.turnId)).toEqual([turnId]);
    virtualization.mockReturnValueOnce({ width: 800, height: 900 });
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SessionProvider, {
          sessionStatus,
          subagentMessages: new Map(),
          children: createElement(Chat, {
            sessionId,
            ...page,
            loading: false,
            sessionStatus,
            agentMessages,
          }),
        })
      )
    );
  }
  try {
    feed({ type: "turn.started", ...stamp });
    message("user", 0, echoMessageId(turnId), createUserEchoParts("Review the change", turnId)[0], {
      kind: "assistant",
      id: "reviewer",
      name: "Reviewer",
    });
    message(
      "assistant",
      1,
      "before",
      createTextPart({ sessionId, messageId: "before" }, "First reply", false)
    );
    message("assistant", 2, "in-progress", {
      type: "tool",
      id: "tool",
      sessionId,
      messageId: "in-progress",
      toolCallId: "build",
      toolName: "Bash",
      state: { status: "in_progress", input: {}, title: "Building", time: { start: 1 } },
    });
    message("user", 3, steerMessageId("s"), createSteerEchoParts("Focus on the tests", "s")[0]);
    message(
      "assistant",
      4,
      "checking",
      createReasoningPart({ sessionId, messageId: "checking" }, "Checking the tests", false)
    );
    message(
      "assistant",
      5,
      "after",
      createTextPart({ sessionId, messageId: "after" }, "Second reply", false)
    );

    const bubbles = render("working");
    expect(bubbles).toMatch(/Review the change.*First reply.*Focus on the tests.*Second reply/s);
    expect(bubbles).toContain('aria-label="Expand activity, Building · 1 tool call"');
    expect(bubbles).not.toMatch(/<article[^>]*\bopacity-60\b/);

    expect(render("working", true)).not.toContain("Second reply");
    // A confirmed stop can release the session before its turn end arrives.
    for (const status of ["idle", "error"] as const) {
      const released = render(status, true);
      expect(released).toContain("First reply");
      expect(released).toContain("Second reply");
      expect(released).not.toContain("activity, Worked");
    }

    client.setQueryData(queryKeys.settings.all, { chat_view: "full" });
    const active = render("working");
    expect(active).toMatch(
      /Sent from.*Reviewer.*Review the change.*First reply.*Focus on the tests.*Second reply/s
    );
    expect(active.match(/Sent from/g)).toHaveLength(1);
    expect(active).not.toContain("Copy response");
    const mutedArticles = [...active.matchAll(/<article[^>]*\bopacity-60\b/g)];
    expect(mutedArticles).toHaveLength(1);
    expect(mutedArticles[0].index).toBeGreaterThan(active.indexOf("Focus on the tests"));

    feed({ type: "turn.ended", ...stamp, timestamp: 2000, stopReason: "cancelled" });
    client.setQueryData(queryKeys.settings.all, { chat_view: "bubbles" });
    // The turn end and the session status travel on separate subscriptions.
    expect(render("working").match(/turn-footer-slot/g)).toHaveLength(1);
    const settled = render("idle");
    expect(settled).toContain("First reply");
    expect(settled).toContain("Second reply");
    expect(settled.match(/Response stopped/g)).toHaveLength(1);
    expect(settled.match(/aria-label="Copy response"/g)).toHaveLength(1);
    expect(settled.match(/aria-label="Expand activity, Worked"/g)).toHaveLength(2);
    expect(settled).toContain('aria-label="Turn took 1s. Started ');
    expect(settled).not.toContain("View turn details");
    expect(settled.indexOf("Response stopped")).toBeGreaterThan(settled.indexOf("Second reply"));
    const virtual = virtualization.mock.calls.at(-1)![0];
    const keys = Array.from({ length: virtual.count }, (_, index) => virtual.getItemKey(index));
    expect(new Set(keys).size).toBe(4);
  } finally {
    client.clear();
  }
});

describe("session alert visibility", () => {
  it.each([
    ["working", true],
    ["needs_response", true],
    ["needs_plan_response", true],
    ["error", true],
    ["idle", false],
  ] satisfies [SessionStatus, boolean][])("%s shows the alert: %s", (sessionStatus, visible) => {
    const client = new QueryClient();
    try {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(Chat, {
            sessionId: "session-1",
            messages,
            loading: false,
            sessionStatus,
            errorMessage: "The agent never confirmed the stop request.",
          })
        )
      );
      expect(html.includes('role="alert"')).toBe(visible);
      expect(html.includes("The agent never confirmed the stop request.")).toBe(visible);
    } finally {
      client.clear();
    }
  });
});

it.each(["worktree", "cloud"] as const)("paints %s user messages on mount", (workspaceKind) => {
  virtualization.mockReturnValueOnce({ width: 800, height: 600 });
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Chat, {
          sessionId: "session-1",
          messages,
          sessionStatus: "working",
          loading: false,
          workspaceKind,
        })
      )
    );
    expect(html).toContain('data-message-id="message-1"');
    expect(html).not.toContain("chat-item-enter");
  } finally {
    client.clear();
  }
});

it.each(["needs_response", "needs_plan_response"] as const)(
  "%s reads live work from the open turn and keeps the progress slot idle",
  (sessionStatus) => {
    // The request can reach the chat before its turn record or the next part update.
    const part = { sessionId: "session-1", messageId: "reply" };
    const reply: Message = {
      ...messages[0],
      id: part.messageId,
      role: "assistant",
      seq: 1,
      parts: [
        { ...part, type: "text", id: "text", text: "See [notes](README.md).", state: "done" },
        { ...part, type: "reasoning", id: "thought", text: "Checking options", state: "streaming" },
      ],
    };
    const client = new QueryClient();
    try {
      virtualization.mockReturnValueOnce({ width: 800, height: 600 });
      const chat = createElement(Chat, {
        sessionId: "session-1",
        messages: [...messages, reply],
        sessionStatus,
        loading: false,
        compactions: [
          {
            compaction_id: "compact",
            session_id: "session-1",
            turn_id: "turn-1",
            status: "completed",
            trigger: "auto",
            created_at: "2026-09-09T10:01:00.000Z",
          },
        ],
      });
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SessionProvider, {
            sessionStatus,
            subagentMessages: new Map(),
            children: chat,
          })
        )
      );
      expect(html).toContain('aria-label="Expand activity, Thinking"');
      expect(html).toContain(">README.md<");
      expect(html).not.toContain("Copy response");
      expect(html).not.toContain("Auto-compacted");
    } finally {
      client.clear();
    }
  }
);

it("keeps separate assistant groups distinct when older messages have no turn ID", () => {
  const client = new QueryClient();
  const rows: Message[] = ["user", "assistant", "user", "assistant"].map((role, index) => ({
    ...messages[0],
    id: `old-${index}`,
    seq: index,
    turn_id: null,
    role: role as Message["role"],
    parts: [{ type: "text", id: `part-${index}`, text: role, state: "done" }],
  }));
  try {
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Chat, {
          sessionId: "session-1",
          messages: rows,
          loading: false,
          sessionStatus: "idle",
        })
      )
    );
    const options = virtualization.mock.calls.at(-1)![0];
    const keys = Array.from({ length: options.count }, (_, index) => options.getItemKey(index));
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(keys.length);
  } finally {
    client.clear();
  }
});

it("notifies scrolling for appended messages within a turn and empty outcomes, but identifies prepended history", () => {
  const client = new QueryClient();
  const assistant = (id: string): Message => ({
    id,
    role: "assistant",
    session_id: "session-1",
    turn_id: "turn-1",
    seq: 1,
    parts: [
      {
        type: "text",
        id: `part-${id}`,
        sessionId: "session-1",
        messageId: id,
        text: id,
        state: "done",
      },
    ],
  });
  function render(rows: Message[], turns: SessionTurn[] = []) {
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Chat, {
          sessionId: "session-1",
          messages: rows,
          turns,
          loading: false,
          sessionStatus: "working",
        })
      )
    );
    return scroll.mock.calls.at(-1)![0] as { contentCount: number; lastContentId: string };
  }
  try {
    const rows = [...messages, assistant("first")];
    const initial = render(rows);
    const continued = render([...rows, assistant("after-tool")]);
    expect(continued.contentCount).toBeGreaterThan(initial.contentCount);
    expect(continued.lastContentId).not.toBe(initial.lastContentId);
    const prompt = [...rows, { ...messages[0], id: "next-prompt", turn_id: "turn-2", seq: 3 }];
    const pending = render(prompt);
    const ended = render(prompt, [{ turnId: "turn-2", stopReason: "cancelled" }]);
    expect(ended.contentCount).toBeGreaterThan(pending.contentCount);
    expect(ended.lastContentId).not.toBe(pending.lastContentId);
    const prepended = render([{ ...messages[0], id: "older", turn_id: "older" }, ...rows]);
    expect(prepended.contentCount).toBeGreaterThan(initial.contentCount);
    expect(prepended.lastContentId).toBe(initial.lastContentId);
  } finally {
    client.clear();
  }
});

it("keeps a first-send refusal in an otherwise empty chat", () => {
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Chat, {
          sessionId: "session-1",
          messages: [],
          loading: false,
          sessionStatus: "error",
          errorMessage: "The engine refused this send.",
        })
      )
    );
    expect(html).toContain("The engine refused this send.");
    expect(html).not.toContain("What would you like to work on?");
  } finally {
    client.clear();
  }
});
