/**
 * Bash Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Bash tool (shell commands).
 *
 * BEFORE: 100 LOC
 * AFTER: ~40 LOC
 */

import { Terminal } from 'lucide-react';
import { BaseToolRenderer, CopyButton } from '../components';
import { cn } from '@/shared/lib/utils';
import type { ToolRendererProps } from '../../chat-types';

export function BashToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { command, description } = toolUse.input;
  const isError = toolResult?.is_error;

  // Show command, optionally prefixed by description
  const commandPreview = command.length > 60 ? command.substring(0, 60) + '...' : command;
  const preview = description
    ? `${description} → ${commandPreview}`
    : commandPreview;

  return (
    <BaseToolRenderer
      toolName="Bash"
      icon={<Terminal className="w-4 h-4 text-primary/70 flex-shrink-0" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono text-[12px] px-2 py-0.5 bg-muted/50 rounded">
          {preview}
        </span>
      )}
      renderContent={({ toolResult }) => {
        if (!toolResult) return null;

        // Extract output content
        const output = typeof toolResult.content === 'object'
          ? JSON.stringify(toolResult.content, null, 2)
          : toolResult.content;

        return (
          <pre
            className={cn(
              'p-4 rounded-lg font-mono text-[13px] overflow-x-auto whitespace-pre-wrap',
              'max-h-[400px] overflow-y-auto border',
              isError
                ? 'bg-destructive/15 text-destructive-foreground border-destructive/30'
                : 'bg-muted/80 text-foreground border-border/60'
            )}
          >
            <div className="text-success font-semibold">$ {command}</div>
            {'\n'}
            {output}
          </pre>
        );
      }}
    />
  );
}
