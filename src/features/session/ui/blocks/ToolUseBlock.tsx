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
import { m } from "framer-motion";
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

  const isLoading = !toolResult;

  return (
    <m.div
      className="my-1"
      style={{ contain: "paint" }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <ToolRendererWrapper block={block} toolResult={toolResult} isLoading={isLoading} />
    </m.div>
  );
}
