import { describe, expect, it, vi } from "vitest";
import type { ToolPart } from "@shared/protocol-types";

vi.mock("@/features/session/ui/tools/registerTools", () => ({}));
const { toToolUseBlocks } = await import("@/features/session/ui/blocks/ToolPartBlock");

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
