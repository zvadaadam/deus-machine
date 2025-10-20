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
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

export function EditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [copiedOld, setCopiedOld] = useState(false);
  const [copiedNew, setCopiedNew] = useState(false);

  const { file_path, old_string, new_string } = toolUse.input;
  const isError = toolResult?.is_error;

  const handleCopy = async (text: string, setter: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

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
                      handleCopy(old_string, setCopiedOld);
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
                      handleCopy(new_string, setCopiedNew);
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
            <div className="p-2 mx-2 mb-2 rounded bg-destructive/10 border border-destructive/30">
              <p className="text-xs text-destructive-foreground font-mono m-0">
                {typeof toolResult.content === 'object'
                  ? JSON.stringify(toolResult.content, null, 2)
                  : toolResult.content}
              </p>
            </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
