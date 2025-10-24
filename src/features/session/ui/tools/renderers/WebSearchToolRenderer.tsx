/**
 * WebSearch Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the WebSearch tool
 * Displays web search queries and results
 *
 * BEFORE: 161 LOC
 * AFTER: ~90 LOC
 */

import { Search } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function WebSearchToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { query, allowed_domains, blocked_domains } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse result content
  const result = toolResult && !isError ? (
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2)
  ) : '';

  const hasResult = result && result.trim().length > 0;

  return (
    <BaseToolRenderer
      toolName="Web Search"
      icon={<Search className="w-4 h-4 text-info-foreground" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      borderColor={isError ? 'error' : 'info'}
      backgroundColor={isError ? 'bg-destructive/5' : 'bg-info/5'}
      renderSummary={() => (
        query && (
          <span className="text-xs text-muted-foreground ml-2 truncate">
            "{query}"
          </span>
        )
      )}
      renderMetadata={() => (
        <div className="px-2 pb-1 space-y-1">
          {query && (
            <div className="flex items-start gap-2 text-sm">
              <Search className="w-3 h-3 text-info-foreground mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-info-foreground break-words">
                  "{query}"
                </div>
              </div>
            </div>
          )}

          {/* Domain filters */}
          {(allowed_domains || blocked_domains) && (
            <div className="text-xs space-y-0.5">
              {allowed_domains && allowed_domains.length > 0 && (
                <div className="flex items-start gap-1.5">
                  <span className="text-muted-foreground">Only:</span>
                  <span className="text-success font-mono">
                    {allowed_domains.join(', ')}
                  </span>
                </div>
              )}
              {blocked_domains && blocked_domains.length > 0 && (
                <div className="flex items-start gap-1.5">
                  <span className="text-muted-foreground">Exclude:</span>
                  <span className="text-destructive font-mono">
                    {blocked_domains.join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      renderContent={() => {
        // No result message
        if (!hasResult) {
          return (
            <div className="px-2 pb-2 text-xs text-muted-foreground italic">
              No results found
            </div>
          );
        }

        // Result display
        return (
          <div className="px-2 pb-2">
            <div className="text-xs text-muted-foreground mb-1">Search Results:</div>
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
