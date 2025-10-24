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

  return (
    <BaseToolRenderer
      toolName="Bash"
      icon={<Terminal className="w-4 h-4 text-info" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={true}
      borderColor="info"
      renderMetadata={() => (
        <div className="px-2 py-1 flex items-start justify-between gap-2">
          <div className="flex-1">
            {description && (
              <div className="text-xs text-muted-foreground mb-1">{description}</div>
            )}
            <code className="text-xs font-mono bg-muted/30 text-success px-2 py-1 rounded block">
              $ {command}
            </code>
          </div>
          <CopyButton text={command} label="Copy" size="sm" />
        </div>
      )}
      renderContent={({ toolResult }) => {
        if (!toolResult) return null;

        return (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Output:</div>
            <pre
              className={cn(
                'p-2 rounded font-mono text-xs overflow-x-auto scrollbar-vibrancy',
                'max-h-[200px] overflow-y-auto',
                isError
                  ? 'bg-destructive/10 text-destructive border border-destructive/30'
                  : 'bg-muted/30 text-success border border-border/40'
              )}
            >
              {typeof toolResult.content === 'object'
                ? JSON.stringify(toolResult.content, null, 2)
                : toolResult.content}
            </pre>
          </div>
        );
      }}
    />
  );
}
