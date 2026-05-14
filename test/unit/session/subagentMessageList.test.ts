import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionProvider } from "@/features/session/context";
import { SubagentMessageList } from "@/features/session/ui/blocks/SubagentMessageList";
import type { Part } from "@shared/messages/types";
import type { Message } from "@/shared/types";

function textPart(id: string, messageId: string, text: string, partIndex = 0): Part {
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

function createMessage(id: string, parts?: Part[]): Message {
  return {
    id,
    session_id: "session-1",
    seq: 1,
    role: "assistant",
    content: "",
    parts,
  };
}

function render(messages: Message[]): string {
  return renderToStaticMarkup(
    React.createElement(
      SessionProvider,
      {
        subagentMessages: new Map(),
        sessionStatus: "idle",
      },
      React.createElement(SubagentMessageList, { messages })
    )
  );
}

describe("SubagentMessageList", () => {
  it("renders part-based assistant child messages", () => {
    const messages: Message[] = [
      createMessage("m-1", [textPart("p-1", "m-1", "First")]),
      createMessage("m-2", [textPart("p-2", "m-2", "After tool")]),
    ];

    const markup = render(messages);

    expect(markup).toContain("First");
    expect(markup).toContain("After tool");
  });

  it("renders nothing when no assistant messages have parts", () => {
    const messages: Message[] = [createMessage("m-1")];

    expect(render(messages)).toBe("");
  });
});
