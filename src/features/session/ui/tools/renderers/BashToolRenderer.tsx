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
      icon={<Terminal className="w-4 h-4 text-muted-foreground/70 flex-shrink-0" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => <span className="font-mono text-[12px]">{preview}</span>}
      renderContent={({ toolResult }) => {
        if (!toolResult) return null;

        // Extract output content
        const output = typeof toolResult.content === 'object'
          ? JSON.stringify(toolResult.content, null, 2)
          : toolResult.content;

        return (
          <pre
            className={cn(
              'p-3 rounded-lg font-mono text-[13px] overflow-x-auto whitespace-pre-wrap',
              'max-h-[400px] overflow-y-auto',
              isError
                ? 'bg-destructive/10 text-destructive border border-destructive/20'
                : 'bg-muted/30 text-foreground'
            )}
          >
            <div className="text-green-600">$ {command}</div>
            {'\n'}
            {output}
          </pre>
        );
      }}
    />
  );
}
