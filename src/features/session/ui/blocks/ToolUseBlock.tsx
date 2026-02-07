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
}: {
  block: ToolUseBlockType;
  toolResult?: ToolResultBlock;
}) {
  const Renderer = toolRegistry.getRenderer(block.name);
  return <Renderer toolUse={block} toolResult={toolResult} />;
}

export function ToolUseBlock({ block, toolResult }: ToolUseBlockProps) {
  const { subagentMessages } = useSession();

  if (!block || !block.name) {
    if (import.meta.env.DEV) {
      console.warn("[ToolUseBlock] Invalid block:", block);
    }
    return null;
  }

  // Route Task blocks with child messages to SubagentGroupBlock
  // Falls back to TaskToolRenderer for Tasks without children (old data)
  if (block.name === "Task" && subagentMessages.has(block.id)) {
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

  return (
    <div className="my-1">
      <ToolRendererWrapper block={block} toolResult={toolResult} />
    </div>
  );
}
