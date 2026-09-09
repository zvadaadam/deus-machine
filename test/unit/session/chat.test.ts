import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { Chat } from "@/features/session/ui/Chat";
import type { SessionStatus } from "@shared/enums";
import type { Message } from "@shared/types/session";

const messages: Message[] = [
  {
    id: "message-1",
    session_id: "session-1",
    turn_id: "turn-1",
    seq: 0,
    role: "user",
    content: "Make a plan",
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
