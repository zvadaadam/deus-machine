import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ToolPart, ToolResultContent } from "@shared/protocol-types";
import { SessionProvider } from "@/features/session/context";
import { ToolPartBlock } from "@/features/session/ui/blocks/ToolPartBlock";
import type { BaseToolRendererProps } from "@/features/session/ui/tools/components/BaseToolRenderer";

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
] as const)(
  "shows the recorded %s call and its input when the completed host part has no result",
  (tool, input) => {
    const html = expanded(completed(tool, "mcp_deus_chat_tools_" + tool, input));
    expect(html).toContain(`Collapse ${tool} tool details`);
    expect(html).toContain(input.toolSummary);
    expect(html).toContain("Input:");
    expect(html).not.toContain("Output:");
    expect(html).not.toContain("No changes found");
    expect(html).not.toContain("tool-loading-shimmer");
  }
);

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
