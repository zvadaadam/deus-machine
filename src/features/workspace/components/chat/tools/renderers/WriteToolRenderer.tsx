/**
 * Write Tool Renderer
 *
 * Specialized renderer for the Write tool (creating new files)
 */

import { useState, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, FilePlus } from 'lucide-react';
import { CodeBlock } from '../components/CodeBlock';
import { FilePathDisplay } from '../components/FilePathDisplay';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';
import { detectLanguageFromPath } from '../utils/detectLanguage';

export function WriteToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const contentId = useId();

  const { file_path, content } = toolUse.input;
  const isError = toolResult?.is_error;

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : chatTheme.blocks.tool.borderLeft.success + ' bg-success/5'
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
        <div className="flex items-center gap-1.5">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          )}
          <FilePlus className="w-4 h-4 text-success" aria-hidden="true" />
          <strong className="font-semibold">Write File</strong>
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Created'}
          </span>
        )}
      </button>

      {/* File path */}
      <FilePathDisplay path={file_path} />

      {/* Expandable content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2 px-2 pb-2">
              {/* File content */}
              <div>
                <div className="text-xs text-muted-foreground mb-1">Content:</div>
                <CodeBlock
                  code={content}
                  language={detectLanguageFromPath(file_path)}
                  showLineNumbers={true}
                  maxHeight="300px"
                />
              </div>

              {/* Error display */}
              {isError && toolResult && (
                <div className="p-2 rounded bg-destructive/10 border border-destructive/30">
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
