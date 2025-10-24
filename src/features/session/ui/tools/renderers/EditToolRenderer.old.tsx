/**
 * Edit Tool Renderer
 *
 * Specialized renderer for the Edit tool (file editing).
 * Shows file path and old_string → new_string changes.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, FileEdit, Copy, Check } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';
import { ToolError } from '../components';
import { useCopyToClipboard } from '@/shared/hooks';

export function EditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const { copy: copyOld, copied: copiedOld } = useCopyToClipboard();
  const { copy: copyNew, copied: copiedNew } = useCopyToClipboard();

  const { file_path, old_string, new_string } = toolUse.input;
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
          <FileEdit className="w-4 h-4 text-info" aria-hidden="true" />
          <strong className="font-semibold">Edit</strong>
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Applied'}
          </span>
        )}
      </div>

      {/* File path */}
      <div className="px-2 py-1">
        <span className="text-xs text-muted-foreground font-mono">
          📁 {file_path}
        </span>
      </div>

      {/* Expandable diff */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-1">
              {/* Diff view */}
              <div className={chatTheme.blocks.diff.container}>
            {/* Before (removed) */}
            <div className="bg-background">
              <div className={cn(chatTheme.blocks.diff.header, chatTheme.blocks.diff.removed.header)}>
                <div className="flex items-center justify-between">
                  <span>− Before</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyOld(old_string);
                    }}
                    className="text-xs hover:bg-destructive/20 px-2 py-0.5 rounded transition-colors flex items-center gap-1"
                    title="Copy before"
                  >
                    {copiedOld ? (
                      <>
                        <Check className="w-3 h-3" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className={cn(chatTheme.blocks.diff.content, chatTheme.blocks.diff.removed.content)}>
                <pre className="m-0">{old_string}</pre>
              </div>
            </div>

            {/* After (added) */}
            <div className="bg-background">
              <div className={cn(chatTheme.blocks.diff.header, chatTheme.blocks.diff.added.header)}>
                <div className="flex items-center justify-between">
                  <span>+ After</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      copyNew(new_string);
                    }}
                    className="text-xs hover:bg-success/20 px-2 py-0.5 rounded transition-colors flex items-center gap-1"
                    title="Copy after"
                  >
                    {copiedNew ? (
                      <>
                        <Check className="w-3 h-3" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className={cn(chatTheme.blocks.diff.content, chatTheme.blocks.diff.added.content)}>
                <pre className="m-0">{new_string}</pre>
              </div>
            </div>
          </div>

          {/* Error display */}
          {isError && toolResult && (
            <ToolError content={toolResult.content} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
