/**
 * KillShell Tool Renderer
 *
 * Specialized renderer for the KillShell tool
 * Terminates background shell processes
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, XCircle, Terminal } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function KillShellToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { shell_id } = toolUse.input;
  const isError = toolResult?.is_error;

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : 'border-l-4 border-l-red-500/50 bg-red-50/20 dark:bg-red-950/10'
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
          <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" aria-hidden="true" />
          <strong className="font-semibold">Kill Background Process</strong>
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Killed'}
          </span>
        )}
      </div>

      {/* Shell ID display */}
      <div className="px-2 pb-1 space-y-1">
        <div className="flex items-center gap-2 text-sm">
          <Terminal className="w-3 h-3 text-red-600 dark:text-red-400" aria-hidden="true" />
          <span className="text-muted-foreground">Shell ID:</span>
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{shell_id}</code>
        </div>
      </div>

      {/* Expandable result */}
      <AnimatePresence initial={false}>
        {isExpanded && toolResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2">
              {!isError ? (
                <div className="text-xs text-success-foreground bg-success/10 border border-success/20 rounded p-2">
                  Background process terminated successfully
                </div>
              ) : (
                <div className="text-xs text-destructive-foreground bg-destructive/10 border border-destructive/30 rounded p-2 font-mono">
                  {typeof toolResult.content === 'object'
                    ? JSON.stringify(toolResult.content, null, 2)
                    : toolResult.content}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
