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

  // Extract domain from URL for preview
  const getDomain = () => {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.hostname.replace('www.', '');
    } catch {
      return url;
    }
  };

  return (
    <BaseToolRenderer
      toolName="Web Fetch"
      icon={<Globe className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono text-[12px] text-muted-foreground truncate">
          {getDomain()}
        </span>
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
