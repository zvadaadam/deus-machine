/**
 * Bash Tool Renderer
 *
 * Specialized renderer for the Bash tool (shell commands)
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { CopyButton } from '../components/CopyButton';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

export function BashToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const { command, description } = toolUse.input;
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
          <Terminal className="w-4 h-4 text-info" aria-hidden="true" />
          <strong className="font-semibold">Bash</strong>
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Done'}
          </span>
        )}
      </div>

      {/* Command */}
      <div className="px-2 py-1 flex items-start justify-between gap-2">
        <div className="flex-1">
          {description && (
            <div className="text-xs text-muted-foreground mb-1">{description}</div>
          )}
          <code className="text-xs font-mono bg-black/50 text-green-400 px-2 py-1 rounded block">
            $ {command}
          </code>
        </div>
        <CopyButton text={command} label="Copy" size="sm" />
      </div>

      {/* Expandable output */}
      {isExpanded && toolResult && (
        <div className="space-y-1 px-2 pb-2">
          <div className="text-xs text-muted-foreground">Output:</div>
          <pre
            className={cn(
              'p-2 rounded font-mono text-xs overflow-x-auto scrollbar-vibrancy',
              'max-h-[200px] overflow-y-auto',
              isError
                ? 'bg-destructive/10 text-destructive border border-destructive/30'
                : 'bg-black/50 text-green-400 border border-border/40'
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
