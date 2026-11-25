import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ToolPart, ToolResultContent } from "@shared/protocol-types";
import { SessionProvider } from "@/features/session/context";
import { ToolPartBlock } from "@/features/session/ui/blocks/ToolPartBlock";
import type { BaseToolRendererProps } from "@/features/session/ui/tools/components/BaseToolRenderer";
import { GlobToolRenderer } from "@/features/session/ui/tools/renderers/GlobToolRenderer";

vi.mock("@/app/providers", () => ({ useTheme: () => ({ actualTheme: "light" }) }));

vi.mock("@/features/session/ui/tools/components/BaseToolRenderer", async (importOriginal) => {
  const { BaseToolRenderer } =
    await importOriginal<
      typeof import("@/features/session/ui/tools/components/BaseToolRenderer")
    >();
  return {
    BaseToolRenderer: (props: BaseToolRendererProps) =>
      createElement(BaseToolRenderer, { ...props, defaultExpanded: true }),
  };
});

function completed(
  tool: string,
  toolName: string,
  input: Record<string, unknown>,
  output = "",
  content?: ToolResultContent[]
): ToolPart {
  return {
    type: "tool",
    id: "part",
    sessionId: "session",
    messageId: "message",
    toolCallId: "call",
    kind: "other",
    toolName,
    mcp: { server: "deus_chat_tools", tool },
    state: { status: "completed", input, output, content, time: { start: 1, end: 2 } },
  };
}

function expanded(part: ToolPart) {
  return renderToStaticMarkup(
    createElement(SessionProvider, {
      sessionStatus: "idle",
      subagentMessages: new Map(),
      children: createElement(ToolPartBlock, { part }),
    })
  );
}

it.each([
  ["fixture_read", { toolSummary: "Read fixture counter" }],
  ["fixture_mark", { toolSummary: "Increment fixture counter" }],
  ["GetWorkspaceDiff", { stat: true, toolSummary: "Get workspace diff stat" }],
  ["BrowserSnapshot", { toolSummary: "Inspect the page" }],
] as const)(
  "shows the recorded %s call and its input when the completed host part has no result",
  (tool, input) => {
    const html = expanded(completed(tool, "mcp_deus_chat_tools_" + tool, input));
    expect(html).toContain(`Collapse ${tool} tool details`);
    expect(html).toContain(input.toolSummary);
    expect(html).toContain("Input:");
    expect(html).toContain("No result recorded");
    expect(html).not.toContain("Output:");
    expect(html).not.toContain("No changes found");
    expect(html).not.toContain("No snapshot captured");
    expect(html).not.toContain("tool-loading-shimmer");
  }
);

it.each([
  ["GetWorkspaceDiff", "No changes found"],
  ["BrowserSnapshot", "No snapshot captured"],
])("keeps %s's empty result distinct from a missing result", (tool, emptyLabel) => {
  const part = completed(tool, tool, {}, "", [{ type: "text", text: "" }]);
  const html = expanded(part);
  expect(html).toContain(emptyLabel);
  expect(html).not.toContain("No result recorded");
});

it("shows the glob input without a file count when the result is absent", () => {
  const html = renderToStaticMarkup(
    createElement(GlobToolRenderer, {
      toolUse: { type: "tool_use", id: "glob", name: "Glob", input: { pattern: "*.ts" } },
    })
  );
  expect(html).toContain("*.ts");
  expect(html).toContain("No result recorded");
  expect(html).not.toMatch(/no files/i);
});

it("keeps in-progress calls and recorded errors out of the missing-result state", () => {
  const part = completed("BrowserSnapshot", "BrowserSnapshot", {});
  const time = { start: 1, end: 2 };
  const pending = expanded({ ...part, state: { status: "in_progress", input: {}, time } });
  const failed = expanded({
    ...part,
    state: { status: "failed", input: {}, time, error: "Tab closed" },
  });
  expect(pending).not.toContain("No result recorded");
  expect(failed).toContain("Tab closed");
  expect(failed).not.toContain("No result recorded");
});

it("keeps the code and line count for a text Read", () => {
  const part = completed("Read", "Read", { file_path: "example.ts" }, "const x = 1;\nconst y = 2;");
  const html = expanded({ ...part, mcp: undefined });
  expect(html).toContain("const x = 1;");
  expect(html).toContain("2 lines");
});

it.each([
  [
    "Claude's content",
    completed("GetWorkspaceDiff", "mcp__deus_chat_tools__GetWorkspaceDiff", { stat: true }, "", [
      { type: "text", text: " src.ts | 1 +" },
    ]),
    " src.ts | 1 +",
  ],
  [
    "Codex's clean diff",
    completed(
      "GetWorkspaceDiff",
      "deus_chat_tools.GetWorkspaceDiff",
      { arguments: { stat: true } },
      "No changes found."
    ),
    "No changes found.",
  ],
] as const)("shows %s in the Workspace Diff card", (_name, part, expected) => {
  const html = expanded(part);
  expect(html).toContain("Collapse Workspace Diff tool details");
  expect(html).toContain(expected);
  expect(html).toContain(">stat<");
});

it("keeps native and other servers' completed parts on their regular cards with an empty output", () => {
  const native = { ...completed("Grep", "Grep", { pattern: "needle" }), mcp: undefined };
  expect(expanded(native)).toContain("0 matches");
  const outside = {
    ...completed("search", "docs.search", { q: "needle" }),
    mcp: { server: "docs", tool: "search" },
  };
  expect(expanded(outside)).toContain("Output:");
});
