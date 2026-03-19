/**
 * Tool Use Block
 *
 * Renders tool invocations using the registry pattern.
 * Automatically selects the appropriate renderer based on tool name.
 *
 * For Task tool_use blocks that have subagent child messages,
 * routes to SubagentGroupBlock to show the agent's internal work.
 *
 * CRITICAL: Receives toolResult prop and passes it to the renderer.
 * This enables renderers to show execution status (✓ Applied / ✗ Failed).
 */

import { memo } from "react";
import type { ToolUseBlock as ToolUseBlockType, ToolResultBlock } from "@/shared/types";
import { toolRegistry } from "../tools/ToolRegistry";
import { SubagentGroupBlock } from "./SubagentGroupBlock";
import { useSession } from "../../context";

interface ToolUseBlockProps {
  block: ToolUseBlockType;
  toolResult?: ToolResultBlock;
}

/**
 * ToolRenderer wrapper component. Defined at module scope to satisfy ESLint rules
 * about components created during render.
 */
function ToolRendererWrapper({
  block,
  toolResult,
  isLoading,
}: {
  block: ToolUseBlockType;
  toolResult?: ToolResultBlock;
  isLoading?: boolean;
}) {
  // Get renderer at this level (component-to-component, not during render)
  const Renderer = toolRegistry.getRenderer(block.name);
  // eslint-disable-next-line react-hooks/static-components
  return <Renderer toolUse={block} toolResult={toolResult} isLoading={isLoading} />;
}

/**
 * Memoized: block and toolResult are the only props, and both are stable references.
 * block is a parsed JSON object that doesn't change after creation.
 * toolResult transitions from undefined → ToolResultBlock once (then stays stable).
 * This prevents re-renders when sibling tools in the same group update.
 */
export const ToolUseBlock = memo(function ToolUseBlock({ block, toolResult }: ToolUseBlockProps) {
  const { subagentMessages } = useSession();

  if (!block || !block.name) {
    if (import.meta.env.DEV) {
      console.warn("[ToolUseBlock] Invalid block:", block);
    }
    return null;
  }

  // Route Task/Agent blocks with child messages to SubagentGroupBlock.
  // SDK uses "Task" (older) or "Agent" (newer) for the same tool.
  // Falls back to TaskToolRenderer for Tasks without children (old data)
  const isAgentTool = block.name === "Task" || block.name === "Agent";
  if (isAgentTool && subagentMessages.has(block.id)) {
    return (
      <div className="my-1">
        <SubagentGroupBlock
          toolUse={block}
          toolResult={toolResult}
          childMessages={subagentMessages.get(block.id)!}
        />
      </div>
    );
  }

  // Debug log to verify memoization is working (should NOT spam on input typing)
  if (import.meta.env.DEV && toolResult) {
    console.debug(
      `[ToolUseBlock] Linking ${block.name} (${block.id}) with result:`,
      toolResult.is_error ? "❌ Error" : "✅ Success"
    );
  }

  const isLoading = !toolResult;

  return (
    <div className="my-1" style={{ contain: "layout style paint" }}>
      <ToolRendererWrapper block={block} toolResult={toolResult} isLoading={isLoading} />
    </div>
  );
});
