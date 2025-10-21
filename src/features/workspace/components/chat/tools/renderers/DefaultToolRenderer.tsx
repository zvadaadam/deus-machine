/**
 * Default Tool Renderer
 *
 * Fallback renderer for tools without a custom renderer.
 * Displays tool input as formatted JSON.
 * Handles MCP tools with special formatting.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, Plug } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../types';

/**
 * Parse MCP tool name into readable parts
 * Example: "mcp__browser-automation-prod-local__browser_snapshot"
 * Returns: { isMcp: true, server: "browser-automation-prod-local", action: "Browser Snapshot" }
 */
function parseMcpToolName(name: string) {
  if (!name.startsWith('mcp__')) {
    return { isMcp: false, displayName: name };
  }

  const parts = name.replace('mcp__', '').split('__');
  if (parts.length < 2) {
    return { isMcp: true, server: parts[0], action: parts[0], displayName: name };
  }

  const server = parts[0];
  const action = parts.slice(1).join('_')
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return {
    isMcp: true,
    server,
    action,
    displayName: action,
  };
}

export function DefaultToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isError = toolResult?.is_error;
  const toolInfo = parseMcpToolName(toolUse.name);

  return (
    <div className={cn(
      chatTheme.blocks.tool.container,
      toolInfo.isMcp
        ? 'border-l-4 border-l-purple-500/50 bg-purple-50/20 dark:bg-purple-950/10'
        : chatTheme.blocks.tool.borderLeft.default
    )}>
      {/* Header - Clickable to expand/collapse */}
      <div
        className={cn(
          chatTheme.blocks.tool.header,
          'cursor-pointer hover:bg-muted/50 p-2 rounded transition-colors'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          )}
          {toolInfo.isMcp ? (
            <Plug className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0" aria-hidden="true" />
          ) : (
            <Wrench className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          )}
          <div className="flex flex-col min-w-0">
            <strong className="font-semibold truncate">{toolInfo.displayName}</strong>
            {toolInfo.isMcp && toolInfo.server && (
              <span className="text-[0.65rem] text-muted-foreground truncate">
                MCP: {toolInfo.server}
              </span>
            )}
          </div>
        </span>

        {/* Result indicator */}
        {toolResult && (
          <span className={cn(
            'text-sm flex-shrink-0',
            isError ? 'text-destructive' : 'text-success'
          )}>
            {isError ? '✗ Failed' : '✓ Success'}
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
