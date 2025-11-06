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

  // Build filter info for preview
  const filterInfo = [];
  if (allowed_domains?.length) filterInfo.push(`only: ${allowed_domains.join(', ')}`);
  if (blocked_domains?.length) filterInfo.push(`exclude: ${blocked_domains.join(', ')}`);
  const filterText = filterInfo.length ? ` • ${filterInfo.join(' • ')}` : '';

  return (
    <BaseToolRenderer
      toolName="Web Search"
      icon={<Search className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="text-xs text-muted-foreground truncate">
          "{query}"{filterText}
        </span>
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
