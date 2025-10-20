/**
 * Block Renderer
 *
 * Smart dispatcher that renders different content block types.
 * Handles text, tool_use, tool_result, and thinking blocks.
 */

import type { ContentBlock } from '@/types';
import { TextBlock } from './TextBlock';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';

interface BlockRendererProps {
  block: ContentBlock;
  index: number;
}

export function BlockRenderer({ block, index }: BlockRendererProps) {
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
      return <TextBlock key={`text-${index}`} block={block} />;

    case 'tool_use':
      return <ToolUseBlock key={`tool-use-${block.id}`} block={block} />;

    case 'tool_result':
      return <ToolResultBlock key={`tool-result-${block.tool_use_id}`} block={block} />;

    default:
      // Graceful fallback for unknown block types
      if (import.meta.env.DEV) {
        console.warn('[BlockRenderer] Unknown block type:', (block as any).type, block);
      }

      // Try to render as text if it's a string
      if (typeof block === 'string') {
        return <TextBlock key={`text-${index}`} block={{ type: 'text', text: block }} />;
      }

      return null;
  }
}
