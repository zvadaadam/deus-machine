import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "@/features/session/ui/Chat";
import type { SessionStatus } from "@shared/enums";
import type { Message, SessionTurn } from "@shared/types/session";

const scroll = vi.hoisted(() => vi.fn());
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
