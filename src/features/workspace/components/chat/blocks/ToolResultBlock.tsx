/**
 * Tool Result Block
 *
 * Renders tool execution results.
 * Shows success/error state with appropriate styling.
 */

import type { ToolResultBlock as ToolResultBlockType } from '@/types';
import { chatTheme } from '../theme';
import { cn } from '@/lib/utils';

interface ToolResultBlockProps {
  block: ToolResultBlockType;
}

export function ToolResultBlock({ block }: ToolResultBlockProps) {
  if (!block) {
    return null;
  }

  const isError = block.is_error;
  let content = block.content || '';

  // Stringify objects/arrays
  if (typeof content === 'object') {
    content = JSON.stringify(content, null, 2);
  }

  // Don't render empty results
  if (!content || content.toString().trim() === '') {
    return null;
  }

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        'mt-1 text-sm',
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/10'
          : chatTheme.blocks.tool.borderLeft.success
      )}
    >
      {/* Header */}
      <div className={chatTheme.blocks.tool.header}>
        <span className={chatTheme.blocks.tool.icon}>
          {isError ? '❌' : '✅'}
        </span>
        <strong className="text-xs font-semibold">
          {isError ? 'Error' : 'Result'}
        </strong>
      </div>

      {/* Content */}
      <pre
        role="region"
        aria-label={isError ? "Tool error" : "Tool result"}
        className={cn(
          chatTheme.blocks.tool.content,
          'max-h-[150px] overflow-y-auto scrollbar-vibrancy',
          isError
            ? 'bg-destructive/10 text-destructive'
            : 'bg-sidebar-accent/40 text-foreground'
        )}
      >
        {content}
      </pre>
    </div>
  );
}
