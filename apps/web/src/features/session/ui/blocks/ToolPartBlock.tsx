import { createElement, memo, useMemo } from "react";
import { match, P } from "ts-pattern";
import type { CompletedToolState, TextContent, ToolPart } from "@shared/messages/types";
import type { ToolUseBlock, ToolResultBlock } from "@/shared/types";
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
    .with({ status: "PENDING" }, (state) => parsePartialInput(state.partialInput))
    .with({ status: P.union("RUNNING", "COMPLETED", "ERROR") }, (state) =>
      coerceToolInput(state.input)
    )
    .exhaustive();

  return {
    type: "tool_use",
    id: part.toolCallId,
    name: part.toolName,
    input,
  };
}

function getCompletedToolResultContent(
  state: CompletedToolState
): string | Record<string, unknown> {
  if (state.content && state.content.length > 0) {
    const textParts = state.content
      .filter((content): content is TextContent => content.type === "text")
      .map((content) => content.text);
    return textParts.join("\n") || JSON.stringify(state.output ?? "");
  }

  if (state.output != null) {
    return typeof state.output === "string" ? state.output : JSON.stringify(state.output, null, 2);
  }

  return "";
}

function toToolResultBlock(part: ToolPart): ToolResultBlock | undefined {
  return match(part.state)
    .with({ status: "COMPLETED" }, (state) => ({
      type: "tool_result" as const,
      tool_use_id: part.toolCallId,
      content: getCompletedToolResultContent(state),
      is_error: false,
    }))
    .with({ status: "ERROR" }, (state) => ({
      type: "tool_result" as const,
      tool_use_id: part.toolCallId,
      content: state.error,
      is_error: true,
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
  const isLoading = part.state.status === "PENDING" || part.state.status === "RUNNING";

  const isAgentTool = part.toolName === "Task" || part.toolName === "Agent";
  if (isAgentTool && !insideSubagent && subagentMessages.has(part.toolCallId)) {
    return (
      <div className="w-full min-w-0">
        <SubagentGroupBlock
          toolUse={toolUse}
          toolResult={toolResult}
          childMessages={subagentMessages.get(part.toolCallId)!}
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
