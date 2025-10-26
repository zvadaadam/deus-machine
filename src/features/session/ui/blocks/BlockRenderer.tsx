/**
 * Block Renderer
 *
 * Smart dispatcher that renders different content block types.
 * Handles text, tool_use, tool_result, and thinking blocks.
 *
 * CRITICAL: Links tool_use blocks with their corresponding tool_result blocks
 * using the toolResultMap. tool_result blocks are NOT rendered standalone -
 * they're only displayed as part of their tool_use block.
 */

import type { ContentBlock, MessageRole } from '@/shared/types';
import { TextBlock } from './TextBlock';
import { ToolUseBlock } from './ToolUseBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { useSession } from '../../context';

interface BlockRendererProps {
  block: ContentBlock;
  index: number;
  role?: MessageRole;
}

export function BlockRenderer({ block, index, role }: BlockRendererProps) {
  const { toolResultMap } = useSession();
  // Handle null/undefined blocks gracefully
  if (!block) {
    if (import.meta.env.DEV) {
      console.warn('[BlockRenderer] Received null/undefined block at index:', index);
    }
    return null;
  }

  // Dispatch based on block type
  switch (block.type) {
    case 'text':
      return <TextBlock block={block} role={role} />;

    case 'tool_use':
      // Link tool_use with its corresponding tool_result
      const toolResult = toolResultMap.get(block.id);
      return <ToolUseBlock block={block} toolResult={toolResult} />;

    case 'tool_result':
      // Don't render tool_result standalone - it's already linked to tool_use
      // Debug log to verify memoization is working (should NOT spam on input typing)
      if (import.meta.env.DEV) {
        console.debug(`[BlockRenderer] Skipping standalone tool_result (tool_use_id: ${block.tool_use_id})`);
      }
      return null;

    case 'thinking':
      return <ThinkingBlock block={block} />;

    default:
      // Graceful fallback for unknown block types
      if (import.meta.env.DEV) {
        console.warn('[BlockRenderer] Unknown block type:', (block as any).type, block);
      }

      // Try to render as text if it's a string
      if (typeof block === 'string') {
        return <TextBlock block={{ type: 'text', text: block }} role={role} />;
      }

      return null;
  }
}
