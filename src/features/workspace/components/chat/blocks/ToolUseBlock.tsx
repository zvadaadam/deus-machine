/**
 * Tool Use Block
 *
 * Renders tool invocations using the registry pattern.
 * Automatically selects the appropriate renderer based on tool name.
 */

import type { ToolUseBlock as ToolUseBlockType } from '@/types';
import { toolRegistry } from '../tools/ToolRegistry';

interface ToolUseBlockProps {
  block: ToolUseBlockType;
}

export function ToolUseBlock({ block }: ToolUseBlockProps) {
  if (!block || !block.name) {
    if (import.meta.env.DEV) {
      console.warn('[ToolUseBlock] Invalid block:', block);
    }
    return null;
  }

  // Get appropriate renderer from registry
  const ToolRenderer = toolRegistry.getRenderer(block.name);

  return (
    <div className="my-1">
      <ToolRenderer toolUse={block} />
    </div>
  );
}
