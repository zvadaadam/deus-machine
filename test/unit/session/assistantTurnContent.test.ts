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
    tool("question", { toolName: "mcp__deus__AskUserQuestion" }),
    tool("plan", { toolName: "ExitPlanMode" }),
    tool("mode", { kind: "switch_mode" }),
    tool("screenshot", { toolName: "BrowserScreenshot" }),
    tool("recording", { toolName: "mcp__browser__recording_stop" }),
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

it("keeps a Project coordinator's delegation visible while other Project reads fold away", () => {
  const delegation = [
    tool("create", { toolName: "mcp__deus__create_agent" }),
    tool("message", { toolName: "mcp__deus__send_to_agent" }),
  ];
  const reads = [
    tool("status", { toolName: "mcp__deus__get_agent_status" }),
    tool("transcript", { toolName: "mcp__deus__read_agent_transcript" }),
  ];
  const result = assistantTurnContent([message("a", [...delegation, ...reads])]);
  expect(result.content).toEqual(delegation);
  expect(result.activity).toEqual(reads);
});
