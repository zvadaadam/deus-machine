/**
 * MultiEdit Tool Renderer
 *
 * Specialized renderer for the MultiEdit tool (multiple edits to one file)
 * Shows all edits with before/after diffs
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, FilePenLine, Copy, Check } from 'lucide-react';
import { FilePathDisplay } from '../components/FilePathDisplay';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

interface Edit {
  old_string: string;
  new_string: string;
}

export function MultiEditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true); // Expanded by default
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const { file_path, edits } = toolUse.input;
  const isError = toolResult?.is_error;
  const editCount = edits?.length || 0;

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : chatTheme.blocks.tool.borderLeft.success
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
          <FilePenLine className="w-4 h-4 text-success" aria-hidden="true" />
          <strong className="font-semibold">Multi Edit</strong>

          {/* Edit count when collapsed */}
          {!isExpanded && (
            <span className="text-xs text-muted-foreground ml-2">
              {editCount} edit{editCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Applied'}
          </span>
        )}
      </div>

      {/* File path */}
      <FilePathDisplay path={file_path} />

      {/* Expandable edits */}
      <AnimatePresence initial={false}>
        {isExpanded && edits && edits.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2 space-y-3">
              <div className="text-xs text-muted-foreground">
                {editCount} edit{editCount !== 1 ? 's' : ''} to apply:
              </div>

              {edits.map((edit: Edit, index: number) => (
                <div key={index} className="space-y-1">
                  {/* Edit number header */}
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span className="bg-muted px-1.5 py-0.5 rounded">
                      Edit {index + 1}/{editCount}
                    </span>
                  </div>

                  {/* Side-by-side diff */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {/* Before (old_string) */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-2 py-1 bg-destructive/10 rounded-t border-l-2 border-l-destructive">
                        <span className="font-medium text-destructive">Before</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(edit.old_string, index * 2);
                          }}
                          className="p-1 hover:bg-destructive/20 rounded transition-colors"
                          title="Copy before"
                          aria-label="Copy before text"
                        >
                          {copiedIndex === index * 2 ? (
                            <Check className="w-3 h-3 text-destructive" />
                          ) : (
                            <Copy className="w-3 h-3 text-destructive" />
                          )}
                        </button>
                      </div>
                      <pre className="p-2 bg-destructive/5 rounded-b border border-destructive/20 overflow-x-auto font-mono whitespace-pre-wrap break-words text-destructive-foreground">
                        {edit.old_string}
                      </pre>
                    </div>

                    {/* After (new_string) */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-2 py-1 bg-success/10 rounded-t border-l-2 border-l-success">
                        <span className="font-medium text-success">After</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(edit.new_string, index * 2 + 1);
                          }}
                          className="p-1 hover:bg-success/20 rounded transition-colors"
                          title="Copy after"
                          aria-label="Copy after text"
                        >
                          {copiedIndex === index * 2 + 1 ? (
                            <Check className="w-3 h-3 text-success" />
                          ) : (
                            <Copy className="w-3 h-3 text-success" />
                          )}
                        </button>
                      </div>
                      <pre className="p-2 bg-success/5 rounded-b border border-success/20 overflow-x-auto font-mono whitespace-pre-wrap break-words text-success-foreground">
                        {edit.new_string}
                      </pre>
                    </div>
                  </div>
                </div>
              ))}
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
