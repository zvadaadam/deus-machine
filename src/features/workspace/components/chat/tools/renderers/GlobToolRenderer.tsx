/**
 * Glob Tool Renderer
 *
 * Specialized renderer for the Glob tool (file pattern matching)
 * Shows matched file paths from glob patterns
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Search, FileSearch } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../types';

export function GlobToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false); // Collapsed by default

  const { pattern, path } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse results - Glob returns newline-separated file paths or "No files found"
  const parseResults = (content: string): string[] => {
    if (!content || content.trim() === '' || content.includes('No files found')) {
      return [];
    }
    return content.split('\n').filter(line => line.trim().length > 0);
  };

  const files = toolResult && !isError ? parseResults(
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content)
  ) : [];

  const hasResults = files.length > 0;
  const resultCount = files.length;

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : hasResults
          ? chatTheme.blocks.tool.borderLeft.success + ' bg-success/5'
          : chatTheme.blocks.tool.borderLeft.default + ' bg-muted/5'
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
          <FileSearch className="w-4 h-4 text-info" aria-hidden="true" />
          <strong className="font-semibold">File Search (Glob)</strong>

          {/* Summary when collapsed */}
          {!isExpanded && toolResult && (
            <span className={cn(
              'text-xs ml-2',
              hasResults ? 'text-success' : 'text-muted-foreground'
            )}>
              {hasResults ? `${resultCount} file${resultCount !== 1 ? 's' : ''} found` : 'No files found'}
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : hasResults ? 'text-success text-sm' : 'text-muted-foreground text-sm'}>
            {isError ? '✗ Failed' : hasResults ? `✓ ${resultCount} found` : '○ None'}
          </span>
        )}
      </div>

      {/* Pattern display */}
      <div className="px-2 pb-1 space-y-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Pattern:</span>
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{pattern}</code>
        </div>
        {path && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Path:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{path}</code>
          </div>
        )}
      </div>

      {/* Expandable file list */}
      <AnimatePresence initial={false}>
        {isExpanded && hasResults && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2 space-y-1">
              <div className="text-xs text-muted-foreground mb-1">Matched files:</div>
              <div className="max-h-60 overflow-y-auto space-y-0.5 pr-1">
                {files.map((file, index) => (
                  <div
                    key={index}
                    className="text-xs font-mono bg-muted/50 hover:bg-muted transition-colors px-2 py-1 rounded group flex items-center gap-2"
                  >
                    <span className="text-muted-foreground opacity-60 group-hover:opacity-100 transition-opacity">
                      {index + 1}.
                    </span>
                    <span className="flex-1 break-all">{file}</span>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* No results message */}
      {!isError && !hasResults && toolResult && (
        <div className="px-2 pb-2 text-xs text-muted-foreground italic">
          No files matched the pattern
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
