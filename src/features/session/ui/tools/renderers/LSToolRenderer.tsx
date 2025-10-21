/**
 * LS Tool Renderer
 *
 * Specialized renderer for the LS tool (list directory contents)
 * Shows directory path and file listings
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, FolderOpen, File, Folder } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function LSToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { path } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse directory listing
  const parseListings = (content: string): string[] => {
    if (!content || content.trim() === '') {
      return [];
    }
    return content.split('\n').filter(line => line.trim().length > 0);
  };

  const listings = toolResult && !isError ? parseListings(
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content)
  ) : [];

  const hasListings = listings.length > 0;
  const itemCount = listings.length;

  // Determine if item is likely a directory (ends with /)
  const isDirectory = (item: string) => item.endsWith('/');

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
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          )}
          <FolderOpen className="w-4 h-4 text-info flex-shrink-0" aria-hidden="true" />
          <strong className="font-semibold">List Directory</strong>

          {/* Count when collapsed */}
          {!isExpanded && toolResult && (
            <span className="text-xs text-muted-foreground ml-2">
              {hasListings ? `${itemCount} item${itemCount !== 1 ? 's' : ''}` : 'Empty'}
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={cn(
            'text-sm flex-shrink-0',
            isError ? 'text-destructive' : 'text-success'
          )}>
            {isError ? '✗ Failed' : '✓ Listed'}
          </span>
        )}
      </div>

      {/* Path display */}
      <div className="px-2 pb-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Path:</span>
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono break-all">{path}</code>
        </div>
      </div>

      {/* Expandable listings */}
      <AnimatePresence initial={false}>
        {isExpanded && hasListings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2">
              <div className="text-xs text-muted-foreground mb-1">Contents ({itemCount}):</div>
              <div className="max-h-60 overflow-y-auto space-y-0.5 pr-1">
                {listings.map((item, index) => {
                  const isDir = isDirectory(item);
                  const cleanItem = item.replace(/\/$/, ''); // Remove trailing slash for display

                  return (
                    <div
                      key={index}
                      className="text-xs font-mono bg-muted/50 hover:bg-muted transition-colors px-2 py-1 rounded group flex items-center gap-2"
                    >
                      {isDir ? (
                        <Folder className="w-3 h-3 text-info flex-shrink-0" aria-hidden="true" />
                      ) : (
                        <File className="w-3 h-3 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                      )}
                      <span className="flex-1 break-all">{cleanItem}</span>
                      {isDir && (
                        <span className="text-[0.65rem] text-muted-foreground opacity-60 group-hover:opacity-100 transition-opacity">
                          DIR
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty directory message */}
      {!isError && !hasListings && toolResult && (
        <div className="px-2 pb-2 text-xs text-muted-foreground italic">
          Directory is empty
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
