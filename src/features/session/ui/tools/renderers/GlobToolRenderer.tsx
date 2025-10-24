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

  // Determine border color based on results
  const getBorderColor = () => {
    if (isError) return 'error';
    if (hasResults) return 'success';
    return 'default';
  };

  const getBackgroundColor = () => {
    if (isError) return 'bg-destructive/5';
    if (hasResults) return 'bg-success/5';
    return 'bg-muted/5';
  };

  return (
    <BaseToolRenderer
      toolName="File Search (Glob)"
      icon={<FileSearch className="w-4 h-4 text-info" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      borderColor={getBorderColor()}
      backgroundColor={getBackgroundColor()}
      renderSummary={() => (
        <span className={cn(
          'text-xs ml-2',
          hasResults ? 'text-success' : 'text-muted-foreground'
        )}>
          {hasResults ? `${resultCount} file${resultCount !== 1 ? 's' : ''} found` : 'No files found'}
        </span>
      )}
      renderMetadata={() => (
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
