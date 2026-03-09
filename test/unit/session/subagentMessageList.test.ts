import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@/features/session/context";
import { SubagentMessageList } from "@/features/session/ui/blocks/SubagentMessageList";
import type { ContentBlock } from "@/features/session/types";
import type { Message } from "@/shared/types";

function createMessage(id: string, blocks: ContentBlock[]): Message {
  return {
    id,
    session_id: "session-1",
    seq: 1,
    role: "assistant",
    content: JSON.stringify(blocks),
  };
}

describe("SubagentMessageList", () => {
  it("renders blocks through SessionContext and skips standalone tool results", () => {
    const renderBlock = vi.fn((block: ContentBlock | string) =>
      React.createElement("span", null, typeof block === "string" ? block : block.type)
    );
    const parseContent = (content: string) => JSON.parse(content) as ContentBlock[];
    const messages: Message[] = [
      createMessage("m-1", [{ type: "text", text: "First" }]),
      createMessage("m-2", [{ type: "tool_result", tool_use_id: "tool-1", content: "ignored" }]),
      createMessage("m-3", [
        { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "src/app.tsx" } },
        { type: "tool_result", tool_use_id: "tool-2", content: "done" },
        { type: "text", text: "After tool" },
      ]),
    ];

    const markup = renderToStaticMarkup(
      React.createElement(
        SessionProvider,
        {
          parseContent,
          toolResultMap: new Map(),
          parentToolUseMap: new Map(),
          subagentMessages: new Map(),
          sessionStatus: "idle",
          renderBlock,
        },
        React.createElement(SubagentMessageList, { messages })
      )
    );

    expect(markup).toContain("text");
    expect(markup).toContain("tool_use");
    expect(renderBlock).toHaveBeenCalledTimes(3);
    expect(
      renderBlock.mock.calls.map(([block]) => (typeof block === "string" ? block : block.type))
    ).toEqual(["text", "tool_use", "text"]);
    expect(
      renderBlock.mock.calls.every(
        ([, , role, isStreaming]) => role === "assistant" && isStreaming === false
      )
    ).toBe(true);
  });

  it("renders nothing when only tool_result blocks remain", () => {
    const renderBlock = vi.fn(() => React.createElement("span", null, "unused"));
    const parseContent = (content: string) => JSON.parse(content) as ContentBlock[];
    const messages: Message[] = [
      createMessage("m-1", [{ type: "tool_result", tool_use_id: "tool-1", content: "ignored" }]),
    ];

    const markup = renderToStaticMarkup(
      React.createElement(
        SessionProvider,
        {
          parseContent,
          toolResultMap: new Map(),
          parentToolUseMap: new Map(),
          subagentMessages: new Map(),
          sessionStatus: "idle",
          renderBlock,
        },
        React.createElement(SubagentMessageList, { messages })
      )
    );

    expect(markup).toBe("");
    expect(renderBlock).not.toHaveBeenCalled();
  });
});
