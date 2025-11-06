/**
 * Tool Use Block
 *
 * Renders tool invocations using the registry pattern.
 * Automatically selects the appropriate renderer based on tool name.
 *
 * CRITICAL: Receives toolResult prop and passes it to the renderer.
 * This enables renderers to show execution status (✓ Applied / ✗ Failed).
 */

import type { ToolUseBlock as ToolUseBlockType, ToolResultBlock } from "@/shared/types";
import { toolRegistry } from "../tools/ToolRegistry";

interface ToolUseBlockProps {
  block: ToolUseBlockType;
  toolResult?: ToolResultBlock;
}

export function ToolUseBlock({ block, toolResult }: ToolUseBlockProps) {
  if (!block || !block.name) {
    if (import.meta.env.DEV) {
      console.warn("[ToolUseBlock] Invalid block:", block);
    }
    return null;
  }

  // Get appropriate renderer from registry
  const ToolRenderer = toolRegistry.getRenderer(block.name);

  // Debug log to verify memoization is working (should NOT spam on input typing)
  if (import.meta.env.DEV && toolResult) {
    console.debug(
      `[ToolUseBlock] Linking ${block.name} (${block.id}) with result:`,
      toolResult.is_error ? "❌ Error" : "✅ Success"
    );
  }

  return (
    <div className="my-1">
      <ToolRenderer toolUse={block} toolResult={toolResult} />
    </div>
  );
}
