import { expect, it } from "vitest";
import { assistantTurnContent, staysAtEnd } from "@/features/session/lib/assistantTurnContent";
import { TELL_USER } from "@shared/agent-message";
import { DEUS_TOOLS_SERVER } from "@shared/mcp-servers";
import { getTurnFooterData } from "@/features/session/ui/utils/getTurnFooterData";
import { extractChatResources } from "@/features/session/lib/chatResources";
import { buildChatTimeline } from "@/features/session/lib/chatTimeline";
import type { Message } from "@/shared/types";
import type { Part, ToolPart } from "@shared/protocol-types";

const message = { sessionId: "session", messageId: "reply" };
const time = { start: 1, end: 2 };
const done = { status: "completed", input: {}, output: "", time } as const;
const text = (id: string): Part => ({ ...message, type: "text", id, text: id, state: "done" });
const tool = (id: string, overrides: Partial<ToolPart> = {}): ToolPart => ({
  ...message,
  type: "tool",
  id,
  toolCallId: id,
  toolName: "Bash",
  kind: "execute",
  state: done,
  ...overrides,
});
const reasoning: Part = {
  ...message,
  id: "think",
  type: "reasoning",
  text: "Tracing the call",
  state: "done",
};
const shape = (blocks: ReturnType<typeof assistantTurnContent>) =>
  blocks.map((block) =>
    block.type === "activity"
      ? block.parts.map((part) => part.id)
      : block.type === "typing"
        ? "Typing…"
        : block.id
  );

const send = (id: string, words = id) =>
  tool(id, {
    kind: "other",
    toolName: `mcp__${DEUS_TOOLS_SERVER}__${TELL_USER}`,
    mcp: { server: DEUS_TOOLS_SERVER, tool: TELL_USER },
    state: { ...done, input: { message: words }, output: "Message sent." },
  });
const n = text("note"),
  a = text("answer"),
  w = tool("work"),
  b = tool("B"),
  s = send("send");
const question = tool("asking", {
  toolName: "AskUserQuestion",
  state: { status: "in_progress", input: {}, time },
});
const waitingPlan = tool("waiting-plan", {
  toolName: "plan",
  kind: undefined,
  state: { status: "pending", partialInput: "" },
});
const failedCommand = tool("failed-command", {
  state: { status: "failed", input: {}, time, error: "Command failed" },
});
const answered = tool("answered", { toolName: "AskUserQuestion" });
const plan = tool("plan", {
  toolName: "plan",
  kind: "switch_mode",
  state: { ...done, input: { plan: "Publish the notes" }, output: "" },
});
const failed = tool("dismissed", {
  toolName: "ExitPlanMode",
  state: {
    status: "failed",
    input: { plan: "Publish the notes" },
    time,
    error: "The user doesn't want to proceed with this plan.",
  },
});
const picture = tool("picture", {
  state: { ...done, content: [{ type: "image", data: "sample", mimeType: "image/png" }] },
});
const recording = tool("recording", { toolName: "deus_chat_tools.recording_stop" });
type RowShape = (string | string[])[];
it.each<[string, Part[], RowShape, RowShape, string[]]>([
  ["text only", [a], ["answer"], [], ["answer"]],
  ["tools then text", [w, a], [["work"], "answer"], [["work", "answer"]], ["answer"]],
  [
    "words between tools",
    [w, n, b, a],
    [["work"], "note", ["B"], "answer"],
    [["work", "note", "B", "answer"]],
    ["answer"],
  ],
  [
    "send mid-run",
    [n, s, w, a],
    ["note", "send", ["work"], "answer"],
    ["send", ["work", "answer"]],
    ["answer"],
  ],
  ["a closing send", [w, s], [["work"], "send"], [["work"], "send"], ["send"]],
  [
    "closing send and text",
    [w, s, a],
    [["work"], "send", "answer"],
    [["work"], "send"],
    ["send", "answer"],
  ],
  [
    "a send before parallel calls",
    [s, w, b],
    ["send", ["work", "B"]],
    ["send", ["work", "B"]],
    ["send"],
  ],
  [
    "a send between parallel calls",
    [w, s, b],
    [["work"], "send", ["B"]],
    [["work"], "send", ["B"]],
    ["send"],
  ],
  [
    "a send after parallel calls",
    [w, b, s],
    [["work", "B"], "send"],
    [["work", "B"], "send"],
    ["send"],
  ],
  [
    "work last with a send",
    [s, n, w],
    ["send", "note", ["work"]],
    ["send", ["note", "work"]],
    ["send"],
  ],
  [
    "work last without a send",
    [n, w, a, b],
    ["note", ["work"], "answer", ["B"]],
    [["note", "work", "answer", "B"]],
    ["answer"],
  ],
  [
    "a waiting card",
    [w, n, question],
    [["work"], "note", "asking"],
    [["work", "note"], "asking"],
    ["note", "asking"],
  ],
  [
    "words following a card",
    [n, question, a],
    ["note", "asking", "answer"],
    ["asking"],
    ["answer", "asking"],
  ],
  [
    "a pending plan without its protocol kind",
    [waitingPlan, a],
    ["waiting-plan", "answer"],
    ["waiting-plan"],
    ["answer", "waiting-plan"],
  ],
  [
    "a failed tool followed by an answer",
    [failedCommand, a],
    ["failed-command", "answer"],
    ["failed-command"],
    ["answer"],
  ],
  ["an answered card", [answered, a], ["answered", "answer"], ["answered"], ["answer"]],
  ["a dismissed plan, with text", [n, failed], ["note", "dismissed"], ["dismissed"], ["note"]],
  [
    "a picture and a recording",
    [n, picture, w, recording],
    ["note", "picture", ["work"], "recording"],
    ["picture", ["work"], "recording"],
    ["note", "picture", "recording"],
  ],
  [
    "stored Codex plan without words",
    [reasoning, plan],
    [["think"], "plan"],
    [["think"], "plan"],
    ["plan"],
  ],
  [
    "dismissed Claude plan without words",
    [answered, failed, w],
    ["answered", "dismissed", ["work"]],
    ["answered", "dismissed", ["work"]],
    ["dismissed"],
  ],
  ["work only", [reasoning, w], [["think", "work"]], [["think", "work"]], []],
])("%s", (_name, parts, plain, condensed, stays) => {
  expect(shape(assistantTurnContent(parts))).toEqual(plain);
  expect(shape(assistantTurnContent(parts, true))).toEqual(condensed);
  expect(staysAtEnd(parts)).toEqual(new Set(stays));
});

it("retains a recorded prose boundary between calls and names an empty live text part as typing", () => {
  const blank = {
    ...message,
    type: "text" as const,
    id: "empty",
    text: "",
    state: "done" as const,
  };
  expect(shape(assistantTurnContent([w, blank, b]))).toEqual([["work"], ["B"]]);
  expect(shape(assistantTurnContent([{ ...blank, state: "streaming" }], true))).toEqual([
    "Typing…",
  ]);
  expect(staysAtEnd([blank])).toEqual(new Set());
  expect(assistantTurnContent([s])[0]).toMatchObject({ type: "text", id: "send", text: "send" });
});

it("anchors condensed work to its first non-word so its disclosure survives settlement", () => {
  const writing = { ...n, type: "text", text: "note", state: "streaming" } as const;
  expect(assistantTurnContent([writing], true)).toEqual([{ type: "typing", id: "note" }]);
  expect(assistantTurnContent([writing, a], true)).toEqual([{ type: "typing", id: "note" }]);
  expect(assistantTurnContent([writing, { ...writing, id: "second" }, a], true)).toEqual([
    { type: "typing", id: "second" },
  ]);
  expect(assistantTurnContent([n], true)).toEqual([]);
  const parts = [n, w, a, b, s];
  expect(assistantTurnContent(parts, true)[0].id).toBe("work");
  expect(assistantTurnContent(parts)[1].id).toBe("work");
  expect(assistantTurnContent([n, reasoning, w], true)[0].id).toBe("think");
});

it.each([question, waitingPlan, recording])("keeps a cancelled $id as a card boundary", (part) => {
  const cancelled = { ...part, state: { status: "cancelled" as const, input: {}, time } };
  expect(shape(assistantTurnContent([w, cancelled, b]))).toEqual([["work"], part.id, ["B"]]);
  expect(staysAtEnd([n, cancelled])).toEqual(new Set(["note"]));
  expect(staysAtEnd([cancelled])).toEqual(new Set([part.id]));
});

it("recognizes media in stored chats and keeps a failed tool as a full-run card", () => {
  for (const part of [
    tool("old", {
      toolName: "mcp__deus__recording_stop",
      mcp: { server: "deus", tool: "recording_stop" },
    }),
    tool("screen", { toolName: "BrowserScreenshot" }),
    { ...message, type: "image" as const, id: "image", mimeType: "image/png" },
  ]) {
    expect(staysAtEnd([part, a])).toEqual(new Set([part.id, a.id]));
  }
  expect(assistantTurnContent([w, failed, b]).map((row) => row.id)).toEqual([
    "work",
    "dismissed",
    "B",
  ]);
});

it("ends every steer-split group together and copies the kept words of each through one footer", () => {
  const row = (id: string, role: Message["role"], parts: Part[], seq: number): Message => ({
    id,
    role,
    parts,
    seq,
    session_id: "s",
    turn_id: "turn",
    sent_at: null,
  });
  const first = row("before", "assistant", [n, w, s], 1),
    last = row("after", "assistant", [b, a], 3);
  const messages = [first, row("steer", "user", [text("Adjust the tag")], 2), last];
  for (const ended of [false, true]) {
    const groups = buildChatTimeline(
      messages,
      [],
      !ended,
      [],
      [{ turnId: "turn", startedAt: 1, ...(ended ? { stopReason: "cancelled", endedAt: 90 } : {}) }]
    ).items.filter((item) => item.type === "assistant");
    expect(groups.map((g) => g.ended)).toEqual([ended, ended]);
    expect(groups.map((g) => g.isStreaming)).toEqual([false, !ended]);
    const stretches = groups.map((g) => g.messages.flatMap((message) => message.parts ?? []));
    expect(stretches.map((parts) => shape(assistantTurnContent(parts, !ended)))).toEqual(
      ended
        ? [
            ["note", ["work"], "send"],
            [["B"], "answer"],
          ]
        : [[["note", "work"], "send"], [["B", "answer"]]]
    );
    expect(stretches.map(staysAtEnd)).toEqual([new Set(["send"]), new Set(["answer"])]);

    expect(groups[0].footerGroups).toBeUndefined();
    expect(groups[1].footerGroups).toEqual(ended ? [[first], [last]] : undefined);
    if (ended)
      expect(getTurnFooterData(groups[1].footerGroups!, undefined, groups[1].record).copyText).toBe(
        "send\n\nanswer"
      );
  }
});

it("copies the closing sends and text and makes cards from links even in a folded send", () => {
  const link = send("resources", "See [the notes](notes.md) and http://localhost:5173.");
  const parts = [link, w, send("update"), a];
  const row: Message = {
    id: "reply",
    seq: 1,
    session_id: "session",
    role: "assistant",
    sent_at: null,
    parts,
  };
  expect(getTurnFooterData([[row]]).copyText).toBe("update\n\nanswer");
  expect(getTurnFooterData([[{ ...row, parts: [link, w] }]]).copyText).toContain("[the notes]");
  expect(extractChatResources({ parts, isComplete: true }).map(({ id }) => id)).toEqual([
    "file:notes.md",
    "website:http://localhost:5173/",
  ]);
});
