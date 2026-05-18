import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "@/features/session/context";
import { SubagentMessageList } from "@/features/session/ui/blocks/SubagentMessageList";
import type { Message } from "@/shared/types";
import type { Part } from "@shared/messages/types";

function createTextPart(id: string, messageId: string, text: string, partIndex: number): Part {
  return {
    type: "TEXT",
    id,
    sessionId: "session-1",
    messageId,
    partIndex,
    text,
    state: "DONE",
  };
}

function createMessage(id: string, parts?: Part[], role: Message["role"] = "assistant"): Message {
  return {
    id,
    session_id: "session-1",
    seq: 1,
    role,
    content: "",
    parts,
  };
}

describe("SubagentMessageList", () => {
  it("renders assistant messages with parts and skips messages without renderable parts", () => {
    const messages: Message[] = [
      createMessage("m-1", [createTextPart("p-1", "m-1", "First", 0)]),
      createMessage("m-2", []),
      createMessage("m-3", [createTextPart("p-2", "m-3", "Second", 0)], "user"),
      createMessage("m-4", [createTextPart("p-3", "m-4", "After tool", 0)]),
    ];

    const markup = renderToStaticMarkup(
      React.createElement(
        SessionProvider,
        {
          subagentMessages: new Map(),
          sessionStatus: "idle",
        },
        React.createElement(SubagentMessageList, { messages })
      )
    );

    expect(markup).toContain("First");
    expect(markup).toContain("After tool");
    expect(markup).not.toContain("Second");
  });

  it("renders nothing when no assistant messages have parts", () => {
    const messages: Message[] = [createMessage("m-1", [])];

    const markup = renderToStaticMarkup(
      React.createElement(
        SessionProvider,
        {
          subagentMessages: new Map(),
          sessionStatus: "idle",
        },
        React.createElement(SubagentMessageList, { messages })
      )
    );

    expect(markup).toBe("");
  });
});
