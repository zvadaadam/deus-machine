import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createSteerEchoParts,
  createTextPart,
  createUserEchoParts,
  echoMessageId,
  steerMessageId,
} from "@zvada/agent-server/protocol/factories";
import { describe, expect, it, vi } from "vitest";
import { foldEvent, messagesKey } from "@/features/session/lib/agentEventFold";
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
  useAutoScroll: (options: unknown) => {
    scroll(options);
    return { showScrollButton: false, handleScrollToBottomClick: () => {} };
  },
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
  function render(sessionStatus: SessionStatus) {
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
          children: createElement(Chat, { ...page, loading: false, sessionStatus }),
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
    message("user", 2, steerMessageId("s"), createSteerEchoParts("Focus on the tests", "s")[0]);
    message(
      "assistant",
      3,
      "after",
      createTextPart({ sessionId, messageId: "after" }, "Second reply", false)
    );

    const active = render("working");
    expect(active).toMatch(
      /Sent from.*Reviewer.*Review the change.*First reply.*Focus on the tests.*Second reply/s
    );
    expect(active.match(/Sent from/g)).toHaveLength(1);
    expect(active).not.toContain("Copy response");
    expect(active.match(/class="opacity-60"/g)).toHaveLength(1);
    expect(active.indexOf('class="opacity-60"')).toBeGreaterThan(
      active.indexOf("Focus on the tests")
    );

    feed({ type: "turn.ended", ...stamp, timestamp: 2000, stopReason: "cancelled" });
    const settled = render("idle");
    expect(settled.match(/Response stopped/g)).toHaveLength(1);
    expect(settled.match(/aria-label="Copy response"/g)).toHaveLength(1);
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

it.each(["needs_response", "needs_plan_response"] as const)(
  "%s keeps the last turn open without presenting it as streaming",
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
      expect(html).toContain('aria-label="Expand activity, Reasoning"');
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
        createElement(Chat, { messages: rows, loading: false, sessionStatus: "idle" })
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
        createElement(Chat, { messages: rows, turns, loading: false, sessionStatus: "working" })
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
