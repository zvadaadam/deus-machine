/**
 * WebFetch Tool Renderer
 *
 * Specialized renderer for the WebFetch tool
 * Fetches and processes web content with AI prompts
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Globe, ExternalLink } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

export function WebFetchToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false); // Collapsed by default

  const { url, prompt } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse result content
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
          : 'border-l-4 border-l-blue-500/50 bg-blue-50/20 dark:bg-blue-950/10'
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
          <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <strong className="font-semibold">Web Fetch</strong>

          {/* URL preview when collapsed */}
          {!isExpanded && url && (
            <span className="text-xs text-muted-foreground ml-2 truncate max-w-xs">
              {url}
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Fetched'}
          </span>
        )}
      </div>

      {/* URL display */}
      <div className="px-2 pb-1 space-y-1">
        {url && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">URL:</span>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline text-xs font-mono truncate flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              {url}
              <ExternalLink className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            </a>
          </div>
        )}
        {prompt && (
          <div className="flex items-start gap-2 text-sm">
            <span className="text-muted-foreground flex-shrink-0">Task:</span>
            <span className="text-xs italic text-muted-foreground">{prompt}</span>
          </div>
        )}
      </div>

      {/* Expandable result */}
      <AnimatePresence initial={false}>
        {isExpanded && hasResult && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2">
              <div className="text-xs text-muted-foreground mb-1">Result:</div>
              <div
                className={cn(
                  'p-3 rounded overflow-x-auto',
                  'bg-muted/50 border border-border',
                  'max-h-96 overflow-y-auto text-sm'
                )}
                style={{ maxHeight: '400px' }}
              >
                <pre className="m-0 whitespace-pre-wrap break-words">{result}</pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* No result message */}
      {!isError && !hasResult && toolResult && (
        <div className="px-2 pb-2 text-xs text-muted-foreground italic">
          No content returned
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
