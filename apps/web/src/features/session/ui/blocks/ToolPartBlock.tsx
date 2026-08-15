import { createElement, memo, useMemo } from "react";
import { match, P } from "ts-pattern";
import type { ToolPart, ToolResultContent, ToolStateCompleted } from "@shared/protocol-types";
import type { ToolUseBlock, ToolResultBlock } from "../tools/types";
import { toolRegistry } from "../tools/ToolRegistry";
import { SubagentGroupBlock } from "./SubagentGroupBlock";
import { useSession } from "../../context";

import "../tools/registerTools";

interface ToolPartBlockProps {
  part: ToolPart;
}

function coerceToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function parsePartialInput(partialInput: string): Record<string, unknown> {
  try {
    return coerceToolInput(JSON.parse(partialInput || "{}"));
  } catch {
    return {};
  }
}

function toToolUseBlock(part: ToolPart): ToolUseBlock {
  const input = match(part.state)
    .with({ status: "pending" }, (state) => parsePartialInput(state.partialInput))
    .with({ status: P.union("in_progress", "completed", "failed", "cancelled") }, (state) =>
      coerceToolInput(state.input)
    )
    .exhaustive();

  return {
    type: "tool_use",
    id: part.toolCallId,
    name: getToolRendererName(part),
    input,
  };
}

function getToolRendererName(part: ToolPart): string {
  return part.kind === "task" || part.subagent ? "Agent" : part.toolName;
}

/**
 * Three-audience doctrine: `content` is the display-grade structured view and
 * `output` the model-facing factual record. Prefer `content` when the harness
 * expressed one, and pass image items through as blocks so renderers (e.g.
 * simulator screenshots) can show them instead of a stringified blob.
 */
function getCompletedToolResultContent(
  state: ToolStateCompleted
): string | Record<string, unknown> | unknown[] {
  const content = state.content;
  if (content && content.length > 0) {
    if (content.some((item) => item.type === "image")) {
      return content.map(toResultBlock);
    }
    const rendered = content.map(renderToolResultContent).filter(Boolean);
    if (rendered.length > 0) return rendered.join("\n");
  }
  return state.output;
}

/** Anthropic-shaped block for the legacy renderer bridge. */
function toResultBlock(content: ToolResultContent): Record<string, unknown> {
  if (content.type === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: content.mimeType, data: content.data },
    };
  }
  return { type: "text", text: renderToolResultContent(content) };
}

function renderToolResultContent(content: ToolResultContent): string {
  if (content.type === "text") return content.text;
  if (content.type === "diff") return content.newText;
  if (content.type === "terminal") return `Terminal output: ${content.terminalId}`;
  return "";
}

function toToolResultBlock(part: ToolPart): ToolResultBlock | undefined {
  return match(part.state)
    .with({ status: "completed" }, (state) => ({
      type: "tool_result" as const,
      tool_use_id: part.toolCallId,
      content: getCompletedToolResultContent(state),
      is_error: false,
    }))
    .with({ status: "failed" }, (state) => ({
      type: "tool_result" as const,
      tool_use_id: part.toolCallId,
      content: state.error,
      is_error: true,
    }))
    .with({ status: "cancelled" }, () => ({
      type: "tool_result" as const,
      tool_use_id: part.toolCallId,
      content: "Cancelled",
      is_error: false,
    }))
    .otherwise(() => undefined);
}

function ToolRendererBridge({
  toolUse,
  toolResult,
  isLoading,
}: {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
  isLoading: boolean;
}) {
  const Renderer = toolRegistry.getRenderer(toolUse.name);
  return createElement(Renderer, { toolUse, toolResult, isLoading });
}

export const ToolPartBlock = memo(function ToolPartBlock({ part }: ToolPartBlockProps) {
  const { subagentMessages, insideSubagent } = useSession();

  const toolUse = useMemo(() => toToolUseBlock(part), [part]);
  const toolResult = useMemo(() => toToolResultBlock(part), [part]);
  const isLoading = part.state.status === "pending" || part.state.status === "in_progress";

  const isAgentTool = part.kind === "task" || !!part.subagent;
  if (isAgentTool && !insideSubagent && subagentMessages.has(part.toolCallId)) {
    return (
      <div className="w-full min-w-0">
        <SubagentGroupBlock
          toolUse={toolUse}
          toolResult={toolResult}
          childMessages={subagentMessages.get(part.toolCallId)!}
          subagent={part.subagent}
        />
      </div>
    );
  }

  const relaxLayoutContain = part.toolName === "Edit" || part.toolName === "MultiEdit";

  return (
    <div
      className="w-full min-w-0"
      style={{ contain: relaxLayoutContain ? "style paint" : "layout style paint" }}
    >
      <ToolRendererBridge toolUse={toolUse} toolResult={toolResult} isLoading={isLoading} />
    </div>
  );
});
