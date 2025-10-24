/**
 * BashOutput Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the BashOutput tool
 * Monitors and displays output from background bash processes
 *
 * BEFORE: 140 LOC
 * AFTER: ~75 LOC
 */

import { Terminal, Activity } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function BashOutputToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { bash_id, filter } = toolUse.input;
  const isError = toolResult?.is_error;

  // Parse output content
  const output = toolResult && !isError ? (
    typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2)
  ) : '';

  const hasOutput = output && output.trim().length > 0;
  const lineCount = hasOutput ? output.split('\n').length : 0;

  return (
    <BaseToolRenderer
      toolName="Background Process Output"
      icon={<Activity className="w-4 h-4 text-info" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={true}
      borderColor={isError ? 'error' : 'info'}
      backgroundColor={isError ? 'bg-destructive/5' : 'bg-info/5'}
      renderSummary={() => (
        <span className="text-xs text-muted-foreground ml-2">
          {hasOutput ? `${lineCount} line${lineCount !== 1 ? 's' : ''}` : 'No output'}
        </span>
      )}
      renderMetadata={() => (
        <div className="px-2 pb-1 space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <Terminal className="w-3 h-3 text-info" aria-hidden="true" />
            <span className="text-muted-foreground">Shell ID:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{bash_id}</code>
          </div>
          {filter && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Filter:</span>
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{filter}</code>
            </div>
          )}
        </div>
      )}
      renderContent={() => {
        // No output message
        if (!hasOutput) {
          return (
            <div className="px-2 pb-2 text-xs text-muted-foreground italic">
              No new output from process
            </div>
          );
        }

        // Output display
        return (
          <div className="px-2 pb-2">
            <div className="text-xs text-muted-foreground mb-1">Output:</div>
            <div
              className={cn(
                'font-mono text-xs p-3 rounded overflow-x-auto',
                'bg-sidebar-accent/90 text-success',
                'border border-border shadow-sm',
                'max-h-96 overflow-y-auto'
              )}
            >
              <pre className="m-0 whitespace-pre-wrap break-words">{output}</pre>
            </div>
          </div>
        );
      }}
    />
  );
}
