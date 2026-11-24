import { describe, expect, it } from "vitest";
import { sentText, TELL_USER, withSentText } from "@shared/agent-message";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import type { ToolPart, ToolState, UnknownPart } from "@shared/protocol-types";

const address = { id: "part", sessionId: "chat", messageId: "reply" };
const mcp = { server: DEUS_TOOLS_SERVER, tool: TELL_USER };
const message = "    code block\n\nCheck **both** cases.\n";
const time = { start: 1, end: 2 };

function completed(toolName: string, input: Record<string, unknown>, output = ""): ToolPart {
  return {
    ...address,
    type: "tool",
    toolName,
    toolCallId: "call",
    kind: "other",
    mcp,
    state: { status: "completed", time, input, output },
  };
}

const claude = completed(`mcp__${mcp.server}__${mcp.tool}`, { message }, "Message sent.");
const codex = completed(`${mcp.server}.${mcp.tool}`, { arguments: { message } }, "Message sent.");
const gemini = completed(`mcp_${mcp.server}_${mcp.tool}`, { message, toolSummary: "Update" });

describe("a message sent while the agent works", () => {
  it.each([
    ["Claude", claude],
    ["Codex", codex],
    ["Gemini", gemini],
  ] as const)(
    "reads %s's completed call as the same text part, preserving the Markdown",
    (_harness, part) => {
      const text = sentText(part);
      expect(text).toEqual({ ...address, type: "text", state: "done", text: message });
      expect(sentText(part)).toBe(text);
    }
  );

  it.each<ToolState>([
    { status: "pending", partialInput: JSON.stringify({ message }) },
    { status: "in_progress", input: { message }, time },
    { status: "failed", input: { message }, time, error: "Refused" },
    { status: "cancelled", input: { message }, time },
  ])("leaves a $status call as a tool", (state) => {
    const part = { ...claude, state };
    expect(sentText(part)).toBeUndefined();
    expect(withSentText([part])[0]).toBe(part);
  });

  it("leaves empty or malformed messages as calls", () => {
    for (const input of [{}, { message: "" }, { message: " \t\n " }, { message: 42 }]) {
      expect(sentText(completed(claude.toolName, input))).toBeUndefined();
    }
  });

  it.each([
    { ...claude, toolName: `mcp__deus__${TELL_USER}`, mcp: { server: "deus", tool: TELL_USER } },
    { ...codex, toolName: `docs.${TELL_USER}`, mcp: { server: "docs", tool: TELL_USER } },
    { ...claude, mcp: undefined },
    { ...claude, toolName: TELL_USER, mcp: undefined },
    { ...claude, mcp: { ...mcp, tool: "read_session" } },
  ])("keeps $toolName as a tool without the host's matching MCP identity", (part) => {
    expect(withSentText([part])[0]).toBe(part);
  });

  it("preserves order and the identity of other parts, including unknown ones", () => {
    const unknown: UnknownPart = { ...address, id: "unknown", type: "future", raw: { more: 1 } };
    const reply = { ...address, id: "closing", type: "text", text: "Finished." } as const;
    const parts = withSentText([unknown, claude, reply] as const);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(unknown);
    expect(parts[1]).toBe(sentText(claude));
    expect(parts[2]).toBe(reply);
  });
});
