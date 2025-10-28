/**
 * Glob Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Glob tool (file pattern matching)
 * Shows matched file paths from glob patterns
 *
 * BEFORE: 147 LOC
 * AFTER: ~90 LOC
 */

import { FileSearch } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function GlobToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
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
    <BaseToolRenderer
      toolName="File Search (Glob)"
      icon={<FileSearch className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono text-[12px] text-muted-foreground">
          {pattern} {path && `in ${path}`} • {hasResults ? `${resultCount} file${resultCount !== 1 ? 's' : ''}` : 'no files'}
        </span>
      )}
      renderContent={() => {
        // No results message
        if (!hasResults) {
          return (
            <div className="px-2 pb-2 text-xs text-muted-foreground italic">
              No files matched the pattern
            </div>
          );
        }

        // File list
        return (
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
        );
      }}
    />
  );
}
