import { expect, it } from "vitest";
import { assistantTurnContent } from "@/features/session/lib/assistantTurnContent";
import type { Message } from "@shared/types/session";
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
const message = (id: string, parts: Part[]): Message => ({
  id,
  session_id: "s",
  seq: 1,
  role: "assistant",
  parts,
});

it("groups activity across message boundaries without hiding any answer text", () => {
  const parts = [text("explanation"), tool("check"), text("answer"), tool("last-tool")];
  const result = assistantTurnContent([
    message("a", parts.slice(0, 2)),
    message("b", parts.slice(2)),
  ]);
  expect(result.activity.map((p) => p.id)).toEqual(["check", "last-tool"]);
  expect(result.content.map((p) => p.id)).toEqual(["explanation", "answer"]);
  expect(result.parts).toEqual(parts);
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
  const result = assistantTurnContent([message("a", visible)]);
  expect(result.activity).toEqual([]);
  expect(result.content).toEqual(visible);
});

it("labels current activity without classifying streamed prose as a final answer", () => {
  const thinking: Part = { type: "reasoning", id: "think", text: "Thinking", state: "streaming" };
  const result = assistantTurnContent([
    message("a", [
      thinking,
      tool("run", {
        state: { status: "in_progress", title: "Running tests" },
      }),
      text("progress"),
    ]),
  ]);
  expect(result.currentActivity).toBe("Running tests");
  expect(result.content.map((p) => p.id)).toEqual(["progress"]);
});
