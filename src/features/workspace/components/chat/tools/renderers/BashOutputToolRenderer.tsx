/**
 * BashOutput Tool Renderer
 *
 * Specialized renderer for the BashOutput tool
 * Monitors and displays output from background bash processes
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Terminal, Activity } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

export function BashOutputToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true); // Expanded by default to see output

  const { bash_id, filter } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse output content
  const output = toolResult && !isError ? (
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2)
  ) : '';

  const hasOutput = output && output.trim().length > 0;
  const lineCount = hasOutput ? output.split('\n').length : 0;

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : chatTheme.blocks.tool.borderLeft.info + ' bg-info/5'
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
          <Activity className="w-4 h-4 text-info" aria-hidden="true" />
          <strong className="font-semibold">Background Process Output</strong>

          {/* Summary when collapsed */}
          {!isExpanded && toolResult && (
            <span className="text-xs text-muted-foreground ml-2">
              {hasOutput ? `${lineCount} line${lineCount !== 1 ? 's' : ''}` : 'No output'}
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Read'}
          </span>
        )}
      </div>

      {/* Process info */}
      <div className="px-2 pb-1 space-y-1">
        <div className="flex items-center gap-2 text-sm">
          <Terminal className="w-3 h-3 text-info" aria-hidden="true" />
          <span className="text-muted-foreground">Shell ID:</span>
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{bash_id}</code>
        </div>
        {filter && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Filter:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{filter}</code>
          </div>
        )}
      </div>

      {/* Expandable output */}
      <AnimatePresence initial={false}>
        {isExpanded && hasOutput && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2">
              <div className="text-xs text-muted-foreground mb-1">Output:</div>
              <div
                className={cn(
                  'font-mono text-xs p-3 rounded overflow-x-auto',
                  'bg-sidebar-accent/90 text-success',
                  'border border-border shadow-sm',
                  'max-h-96 overflow-y-auto'
                )}
              >
                <pre className="m-0 whitespace-pre-wrap break-words">{output}</pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* No output message */}
      {!isError && !hasOutput && toolResult && (
        <div className="px-2 pb-2 text-xs text-muted-foreground italic">
          No new output from process
        </div>
      )}

      {/* Error display */}
      {isError && toolResult && (
        <div className="p-2 mx-2 mb-2 rounded bg-destructive/10 border border-destructive/30">
          <p className="text-xs text-destructive-foreground font-mono m-0">
            {typeof toolResult.content === 'object'
              ? JSON.stringify(toolResult.content, null, 2)
              : toolResult.content}
          </p>
        </div>
      )}
    </div>
  );
}
