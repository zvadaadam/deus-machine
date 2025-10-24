/**
 * WebFetch Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the WebFetch tool
 * Fetches and processes web content with AI prompts
 *
 * BEFORE: 158 LOC
 * AFTER: ~85 LOC
 */

import { Globe, ExternalLink } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function WebFetchToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { url, prompt } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse result content
  const result = toolResult && !isError ? (
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2)
  ) : '';

  const hasResult = result && result.trim().length > 0;

  // Render URL with external link support
  const renderUrl = () => {
    if (!url) return null;

    try {
      const u = new URL(url);
      const safe = u.protocol === 'http:' || u.protocol === 'https:';
      return safe ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline text-xs font-mono truncate flex items-center gap-1"
        >
          {url}
          <ExternalLink className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
        </a>
      ) : (
        <span className="text-xs font-mono truncate text-muted-foreground">{url}</span>
      );
    } catch {
      return <span className="text-xs font-mono truncate text-muted-foreground">{url}</span>;
    }
  };

  return (
    <BaseToolRenderer
      toolName="Web Fetch"
      icon={<Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      borderColor={isError ? 'error' : 'default'}
      backgroundColor={isError ? 'bg-destructive/5' : 'bg-blue-50/20 dark:bg-blue-950/10'}
      renderSummary={() => (
        url && (
          <span className="text-xs text-muted-foreground ml-2 truncate max-w-xs">
            {url}
          </span>
        )
      )}
      renderMetadata={() => (
        <div className="px-2 pb-1 space-y-1">
          {url && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">URL:</span>
              {renderUrl()}
            </div>
          )}
          {prompt && (
            <div className="flex items-start gap-2 text-sm">
              <span className="text-muted-foreground flex-shrink-0">Task:</span>
              <span className="text-xs italic text-muted-foreground">{prompt}</span>
            </div>
          )}
        </div>
      )}
      renderContent={() => {
        // No result message
        if (!hasResult) {
          return (
            <div className="px-2 pb-2 text-xs text-muted-foreground italic">
              No content returned
            </div>
          );
        }

        // Result display
        return (
          <div className="px-2 pb-2">
            <div className="text-xs text-muted-foreground mb-1">Result:</div>
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
        );
      }}
    />
  );
}
