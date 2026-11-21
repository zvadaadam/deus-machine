import { expect, it } from "vitest";
import { assistantTurnContent } from "@/features/session/lib/assistantTurnContent";
import type { Part, ToolPart } from "@shared/protocol-types";

const text = (id: string): Part => ({ type: "text", id, text: id, state: "done" });
const tool = (id: string, overrides: Partial<ToolPart> = {}): ToolPart => ({
  type: "tool",
  id,
  toolCallId: id,
  toolName: "Bash",
  kind: "execute",
  state: { status: "completed", title: "Run checks", content: [] },
  ...overrides,
});
const reasoning: Part = { id: "think", type: "reasoning", text: "Tracing the call", state: "done" };
const shape = (blocks: ReturnType<typeof assistantTurnContent>) =>
  blocks.map((block) =>
    block.type === "activity" ? block.parts.map((part) => part.id) : block.id
  );

it("keeps each progress line between the activity it preceded and followed", () => {
  const parts = [text("A"), tool("one"), text("B"), tool("two"), text("C")];
  expect(shape(assistantTurnContent(parts))).toEqual(["A", ["one"], "B", ["two"], "C"]);
  expect(shape(assistantTurnContent([text("A"), text("B")]))).toEqual(["A", "B"]);
  expect(shape(assistantTurnContent([tool("one"), reasoning]))).toEqual([["one", "think"]]);
});

it("a reasoning or tool run keeps its first part's identity when more parts arrive", () => {
  for (const next of [[], [tool("two")]]) {
    const group = assistantTurnContent([reasoning, tool("one"), ...next]);
    expect(group).toMatchObject([
      { type: "activity", id: "think", parts: [reasoning, tool("one"), ...next] },
    ]);
  }
});

it("keeps failed tools, questions, plans, screenshots and media visible when activity is collapsed", () => {
  const visible = [
    tool("failed", { state: { status: "failed", error: "Command failed" } }),
    tool("question", { toolName: "AskUserQuestion" }),
    tool("plan", { toolName: "ExitPlanMode" }),
    tool("mode", { kind: "switch_mode" }),
    tool("screenshot", { toolName: "BrowserScreenshot" }),
    tool("recording", {
      toolName: "deus_chat_tools.recording_stop",
      mcp: { server: "deus_chat_tools", tool: "recording_stop" },
    }),
    // Stored by older builds: Claude's `deus` server, and a Codex part without `mcp`.
    tool("old-claude-recording", {
      toolName: "mcp__deus__recording_stop",
      mcp: { server: "deus", tool: "recording_stop" },
    }),
    tool("old-codex-recording", { toolName: "deus_chat_tools.recording_stop" }),
    tool("image-output", {
      state: {
        status: "completed",
        content: [{ type: "image", data: "sample", mimeType: "image/png" }],
      },
    }),
    {
      type: "image",
      id: "image",
      url: "https://example.test/image.png",
      mimeType: "image/png",
    } as Part,
  ];
  for (const card of visible) {
    expect(shape(assistantTurnContent([reasoning, card, tool("after")]))).toEqual([
      ["think"],
      card.id,
      ["after"],
    ]);
  }
});
