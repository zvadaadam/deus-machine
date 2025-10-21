/**
 * Read Tool Renderer
 *
 * Specialized renderer for the Read tool (reading file contents)
 */

import { useState, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { CodeBlock } from '../components/CodeBlock';
import { FilePathDisplay } from '../components/FilePathDisplay';
import { chatTheme } from '../../theme';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../types';
import { detectLanguageFromPath } from '../utils/detectLanguage';

export function ReadToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false); // Collapsed by default
  const contentId = useId();

  const { file_path, offset, limit } = toolUse.input;
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
          <FileText className="w-4 h-4 text-info" aria-hidden="true" />
          <strong className="font-semibold">Read File</strong>
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Read'}
          </span>
        )}
      </button>

      {/* File path */}
      <FilePathDisplay path={file_path} />

      {/* Range info */}
      {(offset !== undefined || limit !== undefined) && (
        <div className="px-2 text-xs text-muted-foreground">
          {offset !== undefined && `Offset: ${offset}`}
          {offset !== undefined && limit !== undefined && ' • '}
          {limit !== undefined && `Limit: ${limit} ${Number(limit) === 1 ? 'line' : 'lines'}`}
        </div>
      )}

      {/* Expandable content */}
      <AnimatePresence initial={false}>
        {isExpanded && toolResult && !isError && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-1 px-2 pb-2">
              <div className="text-xs text-muted-foreground">Content:</div>
              <CodeBlock
                code={
                  typeof toolResult.content === 'object'
                    ? JSON.stringify(toolResult.content, null, 2)
                    : toolResult.content
                }
                language={detectLanguageFromPath(file_path)}
                showLineNumbers={true}
                maxHeight="400px"
              />
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
