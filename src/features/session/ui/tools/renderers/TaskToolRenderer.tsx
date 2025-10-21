/**
 * Task Tool Renderer
 *
 * Specialized renderer for the Task tool (Agent spawning)
 * Displays sub-agent tasks with description and detailed prompt
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Cpu, Sparkles } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function TaskToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { description, prompt, subagent_type } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse result if it's an object
  const result = toolResult && !isError ? (
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2)
  ) : '';

  const hasResult = result && result.trim().length > 0;

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : 'border-l-4 border-l-violet-500/50 bg-violet-50/20 dark:bg-violet-950/10'
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
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          )}
          <Cpu className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" aria-hidden="true" />
          <strong className="font-semibold">Spawn Agent</strong>

          {/* Description preview when collapsed */}
          {!isExpanded && description && (
            <span className="text-xs text-muted-foreground ml-2 truncate">
              {description}
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={cn(
            'text-sm flex-shrink-0',
            isError ? 'text-destructive' : 'text-success'
          )}>
            {isError ? '✗ Failed' : '✓ Complete'}
          </span>
        )}
      </div>

      {/* Task details */}
      <div className="px-2 pb-1 space-y-1">
        {description && (
          <div className="flex items-start gap-2 text-sm">
            <Sparkles className="w-3 h-3 text-violet-600 dark:text-violet-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-violet-700 dark:text-violet-300">
                {description}
              </div>
            </div>
          </div>
        )}
        {subagent_type && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Type:</span>
            <code className="bg-muted px-1.5 py-0.5 rounded font-mono">{subagent_type}</code>
          </div>
        )}
      </div>

      {/* Expandable content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2 space-y-2">
              {/* Agent prompt */}
              {prompt && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Task Prompt:</div>
                  <div className="text-xs bg-muted/50 border border-border rounded p-2 max-h-60 overflow-y-auto">
                    <pre className="whitespace-pre-wrap break-words m-0 font-mono">{prompt}</pre>
                  </div>
                </div>
              )}

              {/* Agent result */}
              {hasResult && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Agent Report:</div>
                  <div className="text-xs bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800/40 rounded p-2 max-h-60 overflow-y-auto">
                    <pre className="whitespace-pre-wrap break-words m-0">{result}</pre>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
