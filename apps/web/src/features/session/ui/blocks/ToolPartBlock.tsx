/**
 * Tool Part Block
 *
 * Renders a TOOL Part from the unified Parts model.
 * Bridges the new Part state machine (PENDING/RUNNING/COMPLETED/ERROR)
 * to the existing tool renderer infrastructure (BaseToolRenderer + registry).
 *
 * The TOOL Part contains all the data that was previously split across
 * separate tool_use and tool_result content blocks:
 *   - toolName, toolCallId -> ToolUseBlock.name, ToolUseBlock.id
 *   - state.input -> ToolUseBlock.input
 *   - state.output/error -> ToolResultBlock.content, is_error
 *
 * We synthesize legacy ToolUseBlock/ToolResultBlock shapes to reuse the
 * existing 15+ specialized tool renderers without rewriting them.
 */

import { createElement, memo, useMemo } from "react";
import { match } from "ts-pattern";
import type { ToolPart } from "@shared/messages/types";
import type { PartRow } from "@/shared/types";
import type { ToolUseBlock, ToolResultBlock } from "@/shared/types";
import { toolRegistry } from "../tools/ToolRegistry";
import { SubagentGroupBlock } from "./SubagentGroupBlock";
import { useSession } from "../../context";

// Import tool registry initialization (same as MessageItem)
import "../tools/registerTools";

interface ToolPartBlockProps {
  part: ToolPart;
  partRow: PartRow;
}

/**
 * Synthesize a legacy ToolUseBlock from a TOOL Part.
 * This enables reuse of all existing tool renderers.
 */
function toToolUseBlock(part: ToolPart): ToolUseBlock {
  // Extract input from the state (available in RUNNING, COMPLETED, ERROR states)
  let input: Record<string, any> = {};
  if (part.state.status === "RUNNING" && part.state.input) {
    input = part.state.input as Record<string, any>;
  } else if (part.state.status === "COMPLETED" && part.state.input) {
    input = part.state.input as Record<string, any>;
  } else if (part.state.status === "ERROR" && part.state.input) {
    input = part.state.input as Record<string, any>;
  } else if (part.state.status === "PENDING") {
    // Try to parse partial input
    try {
      input = JSON.parse(part.state.partialInput || "{}");
    } catch {
      input = {};
    }
  }

  return {
    type: "tool_use",
    id: part.toolCallId,
    name: part.toolName,
    input,
  };
}

/**
 * Synthesize a legacy ToolResultBlock from a TOOL Part (if completed/error).
 * Returns undefined for PENDING/RUNNING states (tool result not yet available).
 */
function toToolResultBlock(part: ToolPart): ToolResultBlock | undefined {
  return match(part.state)
    .with({ status: "COMPLETED" }, (state) => {
      // Use structured content if available, otherwise fall back to raw output
      let content: string | Record<string, any>;
      if (state.content && state.content.length > 0) {
        // Convert ToolOutputContent[] to the shape legacy renderers expect
        const textParts = state.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);
        content = textParts.join("\n") || JSON.stringify(state.output ?? "");
      } else if (state.output != null) {
        content =
          typeof state.output === "string" ? state.output : JSON.stringify(state.output, null, 2);
      } else {
        content = "";
      }

      return {
        type: "tool_result" as const,
        tool_use_id: part.toolCallId,
        content,
        is_error: false,
      };
    })
    .with({ status: "ERROR" }, (state) => ({
      type: "tool_result" as const,
      tool_use_id: part.toolCallId,
      content: state.error,
      is_error: true,
    }))
    .otherwise(() => undefined);
}

/**
 * Wrapper to call registry renderer at component scope (not during render).
 */
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

export const ToolPartBlock = memo(function ToolPartBlock({
  part,
  partRow: _partRow,
}: ToolPartBlockProps) {
  const { subagentMessages } = useSession();

  const toolUse = useMemo(() => toToolUseBlock(part), [part]);
  const toolResult = useMemo(() => toToolResultBlock(part), [part]);

  const isLoading = part.state.status === "PENDING" || part.state.status === "RUNNING";

  // Route Task/Agent blocks with child messages to SubagentGroupBlock
  const isAgentTool = part.toolName === "Task" || part.toolName === "Agent";
  if (isAgentTool && subagentMessages.has(part.toolCallId)) {
    return (
      <div className="my-1">
        <SubagentGroupBlock
          toolUse={toolUse}
          toolResult={toolResult}
          childMessages={subagentMessages.get(part.toolCallId)!}
        />
      </div>
    );
  }

  return (
    <div className="my-1" style={{ contain: "layout style paint" }}>
      <ToolRendererBridge toolUse={toolUse} toolResult={toolResult} isLoading={isLoading} />
    </div>
  );
});
