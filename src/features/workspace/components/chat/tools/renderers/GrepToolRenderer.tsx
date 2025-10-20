/**
 * Grep Tool Renderer
 *
 * Specialized renderer for the Grep tool (search results)
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

export function GrepToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const { pattern, path, output_mode, glob, type: fileType } = toolUse.input;
  const isError = toolResult?.is_error;

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : chatTheme.blocks.tool.borderLeft.info
      )}
    >
      {/* Header */}
      <div
        className={cn(
          chatTheme.blocks.tool.header,
          'cursor-pointer hover:bg-muted/50 p-2 rounded transition-colors justify-between'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          )}
          <Search className="w-4 h-4 text-info" aria-hidden="true" />
          <strong className="font-semibold">Grep Search</strong>
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Found'}
          </span>
        )}
      </div>

      {/* Search pattern */}
      <div className="px-2 py-1 flex items-start justify-between gap-2">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Pattern:</span>
            <code className="text-xs font-mono bg-info/10 text-info px-1.5 py-0.5 rounded">
              {pattern}
            </code>
          </div>

          {path && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Path:</span>
              <code className="text-xs font-mono text-muted-foreground">
                {path}
              </code>
            </div>
          )}

          {glob && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Glob:</span>
              <code className="text-xs font-mono text-muted-foreground">
                {glob}
              </code>
            </div>
          )}

          {fileType && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Type:</span>
              <code className="text-xs font-mono text-muted-foreground">
                {fileType}
              </code>
            </div>
          )}

          {output_mode && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Mode:</span>
              <code className="text-xs font-mono text-muted-foreground">
                {output_mode}
              </code>
            </div>
          )}
        </div>

        <CopyButton text={pattern} label="Copy pattern" size="sm" />
      </div>

      {/* Expandable results */}
      {isExpanded && toolResult && (
        <div className="space-y-1 px-2 pb-2">
          <div className="text-xs text-muted-foreground">Results:</div>
          <pre
            className={cn(
              chatTheme.blocks.tool.content,
              'max-h-[300px] overflow-y-auto scrollbar-vibrancy',
              isError
                ? 'bg-destructive/10 text-destructive border border-destructive/30'
                : 'bg-sidebar-accent/40 text-foreground border border-border/40'
            )}
          >
            {typeof toolResult.content === 'object'
              ? JSON.stringify(toolResult.content, null, 2)
              : toolResult.content}
          </pre>
        </div>
      )}
    </div>
  );
}
