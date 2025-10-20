/**
 * Default Tool Renderer
 *
 * Fallback renderer for tools without a custom renderer.
 * Displays tool input as formatted JSON.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

export function DefaultToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isError = toolResult?.is_error;

  return (
    <div className={cn(chatTheme.blocks.tool.container, chatTheme.blocks.tool.borderLeft.default)}>
      {/* Header - Clickable to expand/collapse */}
      <div
        className={cn(
          chatTheme.blocks.tool.header,
          'cursor-pointer hover:bg-muted/50 p-2 rounded transition-colors'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="flex items-center gap-1.5">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          )}
          <Wrench className="w-4 h-4" aria-hidden="true" />
          <strong className="font-semibold">{toolUse.name}</strong>
        </span>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive' : 'text-success'}>
            {isError ? '✗' : '✓'}
          </span>
        )}
      </div>

      {/* Expandable content */}
      {isExpanded && (
        <div className="space-y-2">
          {/* Tool input */}
          <div>
            <div className="text-xs text-muted-foreground mb-1 px-2">Input:</div>
            <pre className={cn(chatTheme.blocks.tool.content, 'bg-sidebar-accent/40')}>
              {JSON.stringify(toolUse.input, null, 2)}
            </pre>
          </div>

          {/* Tool result (if available) */}
          {toolResult && (
            <div>
              <div className="text-xs text-muted-foreground mb-1 px-2">
                {isError ? 'Error:' : 'Result:'}
              </div>
              <pre
                className={cn(
                  chatTheme.blocks.tool.content,
                  isError
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-sidebar-accent/40'
                )}
              >
                {typeof toolResult.content === 'object'
                  ? JSON.stringify(toolResult.content, null, 2)
                  : toolResult.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
