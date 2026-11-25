import { expect, it } from "vitest";
import { TELL_USER } from "@shared/agent-message";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import type { Part, ToolPart } from "@shared/protocol-types";
import { activityLabel } from "@/features/session/ui/utils/activityLabel";

const message = { sessionId: "session", messageId: "reply" };
const time = { start: 1, end: 2 };
const done = { status: "completed", input: {}, output: "", time } as const;
const running = { status: "in_progress", input: {}, time: { start: 1 } } as const;
const thought: Part = {
  ...message,
  id: "thought",
  type: "reasoning",
  text: "",
  state: "streaming",
};

function tool(
  toolName: string,
  state: ToolPart["state"],
  overrides: Partial<ToolPart> = {}
): ToolPart {
  return {
    ...message,
    id: toolName,
    type: "tool",
    toolCallId: toolName,
    toolName,
    state,
    ...overrides,
  };
}

it("counts each file in a completed Codex patch once, including deletions", () => {
  const patch = tool("apply_patch", {
    ...done,
    content: [
      { type: "diff", path: "a.ts", oldText: "a", newText: "b" },
      { type: "diff", path: "a.ts", oldText: "c", newText: "d" },
      { type: "diff", path: "deleted.ts", oldText: "old", newText: "" },
    ],
  });
  const failed = tool(
    "apply_patch",
    { status: "failed", input: { file_path: "other.ts" }, error: "failed", time },
    { id: "failed", toolCallId: "failed" }
  );
  expect(activityLabel([patch, failed], false)).toBe("Activity · 2 tool calls · 2 files changed");
});

it("counts subagents and only completed file changes", () => {
  const parts = [
    tool("Edit", { ...done, input: { file_path: "app.ts" } }),
    tool("Write", { ...running, input: { file_path: "running.ts" } }),
    tool("MultiEdit", {
      status: "failed",
      input: { file_path: "error.ts" },
      error: "failed",
      time,
    }),
    tool("Task", done, { kind: "task" }),
  ];
  expect(activityLabel(parts, false)).toBe("Activity · 1 subagent · 4 tool calls · 1 file changed");
  expect(activityLabel([...parts, tool("delegate", done, { subagent: {} })], false)).toBe(
    "Activity · 2 subagents · 5 tool calls · 1 file changed"
  );
});

it("labels reasoning and shows a step count for adjacent thoughts", () => {
  expect(activityLabel([thought], false)).toBe("Reasoning");
  expect(activityLabel([{ ...thought, id: "first", state: "done" }, thought], true)).toBe(
    "Thinking · 2 steps"
  );
});

it("uses the last active part, with the tool's title, running title or card name", () => {
  const bash = tool("Bash", { ...running, title: "Checking types" });
  expect(activityLabel([thought, { ...bash, title: "Build" }], true)).toBe("Build · 1 tool call");
  expect(activityLabel([bash, tool("Read", done)], true)).toBe("Checking types · 2 tool calls");
  expect(activityLabel([bash, thought], true)).toBe("Thinking · 1 tool call");
  const pending = tool("deus_chat_tools.list_sessions", { status: "pending", partialInput: "" });
  expect(activityLabel([pending], true)).toBe("list_sessions · 1 tool call");
  expect(activityLabel([pending], false)).toBe("Activity · 1 tool call");
});

it("labels a work run while its trailing native words stream", () => {
  const text: Part = {
    ...message,
    type: "text",
    id: "words",
    text: "Checking",
    state: "streaming",
  };
  expect(activityLabel([tool("Read", done), text], true)).toBe("Typing… · 1 tool call");
});

it("labels an in-flight tell_user call as Typing… instead of raw tool name", () => {
  const pendingSend = tool(
    `mcp__${DEUS_TOOLS_SERVER}__${TELL_USER}`,
    { status: "pending", partialInput: '{"message":"Checking' },
    { mcp: { server: DEUS_TOOLS_SERVER, tool: TELL_USER } }
  );
  const runningSend = tool(
    `mcp__${DEUS_TOOLS_SERVER}__${TELL_USER}`,
    { ...running, input: { message: "Checking" } },
    { mcp: { server: DEUS_TOOLS_SERVER, tool: TELL_USER } }
  );
  expect(activityLabel([pendingSend], true)).toBe("Typing… · 1 tool call");
  expect(activityLabel([runningSend], true)).toBe("Typing… · 1 tool call");
});
