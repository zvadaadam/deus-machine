import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "@/features/session/context";
import type { ToolPart } from "@shared/protocol-types";
import { toToolUseBlocks } from "@/features/session/ui/blocks/ToolPartBlock";
import { toolRegistry } from "@/features/session/ui/tools/ToolRegistry";
import {
  BashToolRenderer,
  DefaultToolRenderer,
  WriteToolRenderer,
} from "@/features/session/ui/tools/renderers";

function part(overrides: Partial<ToolPart>): ToolPart {
  return {
    id: "p1",
    messageId: "m1",
    sessionId: "s1",
    partIndex: 0,
    type: "tool",
    toolCallId: "call-1",
    toolName: "shell",
    kind: "execute",
    state: { status: "completed", input: {}, output: "" },
    ...overrides,
  } as ToolPart;
}

const patch = (content: unknown[], changes: unknown[] = []) =>
  part({
    toolName: "apply_patch",
    kind: "edit",
    state: { status: "completed", input: { changes }, output: "update", content },
  } as Partial<ToolPart>);

describe("a Codex tool drawn as Claude's card", () => {
  it("a command is the Bash card, without Codex's shell", () => {
    const [card, ...rest] = toToolUseBlocks(
      part({
        command: "python3 -c 'print(1)'",
        state: {
          status: "completed",
          input: { command: "/bin/zsh -lc \"python3 -c 'print(1)'\"" },
          output: "1\n",
        },
      } as Partial<ToolPart>)
    );
    expect(rest).toEqual([]);
    expect(card).toMatchObject({ name: "Bash", input: { command: "python3 -c 'print(1)'" } });
  });

  it("a patch is one card per file: Edit, MultiEdit for several hunks, Write for a new file, a deletion as one Edit", () => {
    const cards = toToolUseBlocks(
      patch(
        [
          { type: "diff", path: "/w/a.py", oldText: "x", newText: "x\ny" },
          { type: "diff", path: "/w/b.py", oldText: "1", newText: "2" },
          { type: "diff", path: "/w/b.py", oldText: "9", newText: "8" },
          { type: "diff", path: "/w/new.py", newText: "print(1)\n" },
          { type: "diff", path: "/w/gone.py", oldText: "old\nfile\n", newText: "" },
        ],
        [
          { path: "/w/new.py", kind: { type: "add" } },
          { path: "/w/gone.py", kind: "delete" },
        ]
      )
    );
    expect(cards.map(({ name, input }) => [name, input])).toEqual([
      ["Edit", { file_path: "/w/a.py", old_string: "x\n", new_string: "x\ny\n" }],
      [
        "MultiEdit",
        {
          file_path: "/w/b.py",
          edits: [
            { old_string: "1\n", new_string: "2\n" },
            { old_string: "9\n", new_string: "8\n" },
          ],
        },
      ],
      ["Write", { file_path: "/w/new.py", content: "print(1)\n" }],
      ["Edit", { file_path: "/w/gone.py", old_string: "old\nfile\n", new_string: "" }],
    ]);
    expect(new Set(cards.map(({ id }) => id)).size).toBe(4);
  });

  it("a hunk that adds or removes a trailing blank line still shows the change", () => {
    // `hunkDiff` gives ["a"] and ["a", ""] as "a" and "a\n".
    const [added] = toToolUseBlocks(
      patch([{ type: "diff", path: "/w/a", oldText: "a", newText: "a\n" }])
    );
    const [removed] = toToolUseBlocks(
      patch([{ type: "diff", path: "/w/a", oldText: "a\n", newText: "a" }])
    );
    expect(added.input).toEqual({ file_path: "/w/a", old_string: "a\n", new_string: "a\n\n" });
    expect(removed.input).toEqual({ file_path: "/w/a", old_string: "a\n\n", new_string: "a\n" });
  });

  it("a part saved before the engine said command or diff keeps the generic card", () => {
    const shell = part({ state: { status: "completed", input: { command: "ls" }, output: "" } });
    expect(toToolUseBlocks(shell)).toMatchObject([{ name: "shell", input: { command: "ls" } }]);
    expect(toToolUseBlocks(patch([]))).toMatchObject([{ name: "apply_patch" }]);
  });
});

describe("whole files in Gemini's recorded tool parts", () => {
  const small = "start\ncolor=blue\nend\n";
  const large = Array.from(
    { length: 320 },
    (_, i) => `row ${String(i + 1).padStart(3, "0")} | ${i === 159 ? "before" : "fixture"}\n`
  ).join("");

  it.each([
    ["/w/small.txt", small, "color=blue", "color=green"],
    ["/w/large.txt", large, "row 160 | before", "row 160 | after"],
  ])("keeps both complete sides of the edit to %s", (path, oldText, target, replacement) => {
    const newText = oldText.replace(target, replacement);
    const edit = part({
      toolName: "edit_file",
      kind: "edit",
      locations: [{ path }],
      state: {
        status: "completed",
        time: { start: 1, end: 2 },
        output: "",
        input: { Path: path, Target: target, Replacement: replacement },
        content: [{ type: "diff", path, oldText, newText }],
      },
    });
    expect(toToolUseBlocks(edit)).toMatchObject([
      { name: "Edit", input: { file_path: path, old_string: oldText, new_string: newText } },
    ]);
  });

  it("writes the new file including its final newline", () => {
    const path = "/w/small.txt";
    const write = part({
      toolName: "write_file",
      kind: "edit",
      locations: [{ path }],
      state: {
        status: "completed",
        time: { start: 1, end: 2 },
        output: "",
        input: { Path: path, Overwrite: true, Content: small },
        content: [{ type: "diff", path, newText: small }],
      },
    });
    expect(toToolUseBlocks(write)).toMatchObject([
      { name: "Write", input: { file_path: path, content: small } },
    ]);
  });
});

describe("a tool's own card and the fields an unregistered tool carries", () => {
  it("keeps a monitor's description and timeout and a Bash call's full input", () => {
    for (const [toolName, input, renderer] of [
      [
        "Monitor",
        { command: "tail -f log", description: "Watch the log", timeout_ms: 1000 },
        DefaultToolRenderer,
      ],
      [
        "Bash",
        { command: "ls", description: "List files", run_in_background: true },
        BashToolRenderer,
      ],
    ] as const) {
      const call = part({
        toolName,
        command: input.command,
        state: { status: "in_progress", input, time: { start: 1 } },
      });
      expect(toToolUseBlocks(call)).toEqual([
        { type: "tool_use", id: "call-1", name: toolName, input },
      ]);
      expect(toolRegistry.getRenderer(toolName)).toBe(renderer);
    }
  });

  it("keeps the cell input of a notebook edit that returns a diff", () => {
    const input = { notebook_path: "/w/n.ipynb", cell_id: "c1", new_source: "x = 2" };
    const call = part({
      toolName: "NotebookEdit",
      kind: "edit",
      state: {
        status: "completed",
        input,
        output: "",
        time: { start: 1, end: 2 },
        content: [{ type: "diff", path: input.notebook_path, oldText: "x = 1", newText: "x = 2" }],
      },
    });
    expect(toToolUseBlocks(call)).toEqual([
      { type: "tool_use", id: "call-1", name: "NotebookEdit", input },
    ]);
    expect(toolRegistry.getRenderer(call.toolName)).toBe(DefaultToolRenderer);
  });

  it("draws an unregistered tool from its command or file diff", () => {
    expect(toToolUseBlocks(part({ toolName: "command_tool", command: "pwd" }))).toMatchObject([
      { name: "Bash", input: { command: "pwd" } },
    ]);
    const edit = patch([{ type: "diff", path: "/w/n", newText: "hello" }]);
    expect(toToolUseBlocks({ ...edit, toolName: "file_tool" })).toMatchObject([
      { name: "Write", input: { file_path: "/w/n", content: "hello" } },
    ]);
  });
});

describe("a card's line counts", () => {
  it("shows +3 for a three-line write ending in a newline", () => {
    const html = renderToStaticMarkup(
      createElement(SessionProvider, {
        sessionStatus: "idle",
        subagentMessages: new Map(),
        children: createElement(WriteToolRenderer, {
          toolUse: {
            type: "tool_use",
            id: "create",
            name: "Write",
            input: { file_path: "small.txt", content: "start\ncolor=blue\nend\n" },
          },
        }),
      })
    );
    expect(html).toContain(">+3<");
  });

  it("counts no line for an empty side and none after a final newline", async () => {
    const { computeDiffStats } = await import("@/features/session/ui/tools/utils/computeDiffStats");
    // A deleted two-line file with no final newline.
    expect(computeDiffStats("a\nb", "")).toEqual({ added: 0, removed: 2 });
    // The same lines with and without the final newline.
    expect(computeDiffStats("a\nb\n", "a\nb\nc\n")).toEqual({ added: 1, removed: 0 });
    expect(computeDiffStats("a\n", "a\n\n")).toEqual({ added: 1, removed: 0 });
  });
});

describe("an MCP tool's card", () => {
  const mcp = (server: string, tool: string, toolName: string) =>
    part({ toolName, kind: "other", mcp: { server, tool } } as Partial<ToolPart>);

  it("is Deus's own card for a Deus tool, on both harnesses' spelling", () => {
    for (const toolName of [
      "mcp__deus_chat_tools__BrowserScreenshot",
      "deus_chat_tools.BrowserScreenshot",
    ]) {
      const [card] = toToolUseBlocks(mcp("deus_chat_tools", "BrowserScreenshot", toolName));
      expect(card).toMatchObject({ name: "BrowserScreenshot" });
    }
  });

  it("draws a Deus tool stored under an older build's name with its Deus card", () => {
    const [claude] = toToolUseBlocks(
      part({
        toolName: "mcp__deus__BrowserScreenshot",
        kind: "other",
        mcp: { server: "deus", tool: "BrowserScreenshot" },
      } as Partial<ToolPart>)
    );
    expect(claude).toMatchObject({ name: "BrowserScreenshot" });
    const [codex] = toToolUseBlocks(
      part({ toolName: "deus_chat_tools.recording_stop", kind: "other" } as Partial<ToolPart>)
    );
    expect(codex).toMatchObject({ name: "recording_stop" });
    const [personal] = toToolUseBlocks(
      part({
        toolName: "deus.Edit",
        kind: "other",
        mcp: { server: "deus", tool: "Edit" },
      } as Partial<ToolPart>)
    );
    expect(personal).toMatchObject({ name: "deus.Edit" });
    const [outside] = toToolUseBlocks(
      part({ toolName: "mcp__docs__Edit", kind: "other" } as Partial<ToolPart>)
    );
    expect(outside).toMatchObject({ name: "mcp__docs__Edit" });
  });

  it("keeps another server's tool named like a built-in off the built-in's card", () => {
    for (const toolName of ["mcp__docs__Edit", "docs.Edit"]) {
      const [card] = toToolUseBlocks(mcp("docs", "Edit", toolName));
      expect(card).toMatchObject({ name: toolName });
    }
  });
});
