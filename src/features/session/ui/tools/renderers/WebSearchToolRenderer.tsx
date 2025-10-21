/**
 * WebSearch Tool Renderer
 *
 * Specialized renderer for the WebSearch tool
 * Displays web search queries and results
 */

import { useState, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Search, ExternalLink } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function WebSearchToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false); // Collapsed by default
  const contentId = useId();

  const { query, allowed_domains, blocked_domains } = toolUse.input;
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
          : 'border-l-4 border-l-info/50 bg-info/5'
      )}
    >
      {/* Header */}
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className={cn(
          chatTheme.blocks.tool.header,
          'w-full text-left hover:bg-muted/50 p-2 rounded transition-colors justify-between',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          )}
          <Search className="w-4 h-4 text-info-foreground flex-shrink-0" aria-hidden="true" />
          <strong className="font-semibold">Web Search</strong>

          {/* Query preview when collapsed */}
          {!isExpanded && query && (
            <span className="text-xs text-muted-foreground ml-2 truncate">
              "{query}"
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={cn(
            'text-sm flex-shrink-0',
            isError ? 'text-destructive' : 'text-success'
          )}>
            {isError ? '✗ Failed' : '✓ Found'}
          </span>
        )}
      </button>

      {/* Query display */}
      <div className="px-2 pb-1 space-y-1">
        {query && (
          <div className="flex items-start gap-2 text-sm">
            <Search className="w-3 h-3 text-info-foreground mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-info-foreground break-words">
                "{query}"
              </div>
            </div>
          </div>
        )}

        {/* Domain filters */}
        {(allowed_domains || blocked_domains) && (
          <div className="text-xs space-y-0.5">
            {allowed_domains && allowed_domains.length > 0 && (
              <div className="flex items-start gap-1.5">
                <span className="text-muted-foreground">Only:</span>
                <span className="text-success font-mono">
                  {allowed_domains.join(', ')}
                </span>
              </div>
            )}
            {blocked_domains && blocked_domains.length > 0 && (
              <div className="flex items-start gap-1.5">
                <span className="text-muted-foreground">Exclude:</span>
                <span className="text-destructive font-mono">
                  {blocked_domains.join(', ')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Expandable result */}
      <AnimatePresence initial={false}>
        {isExpanded && hasResult && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2">
              <div className="text-xs text-muted-foreground mb-1">Search Results:</div>
              <div
                className={cn(
                  'p-3 rounded overflow-x-auto',
                  'bg-muted/50 border border-border',
                  'max-h-96 overflow-y-auto text-sm'
                )}
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
          No results found
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
