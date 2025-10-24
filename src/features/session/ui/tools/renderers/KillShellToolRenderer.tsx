/**
 * KillShell Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the KillShell tool
 * Terminates background shell processes
 *
 * BEFORE: 94 LOC
 * AFTER: ~55 LOC
 */

import { XCircle, Terminal } from 'lucide-react';
import { BaseToolRenderer } from '../components';
import type { ToolRendererProps } from '../../chat-types';

export function KillShellToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { shell_id } = toolUse.input;
  const isError = toolResult?.is_error;

  return (
    <BaseToolRenderer
      toolName="Kill Background Process"
      icon={<XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      borderColor={isError ? 'error' : 'warning'}
      backgroundColor="bg-destructive/5"
      renderMetadata={() => (
        <div className="px-2 pb-1 space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <Terminal className="w-3 h-3 text-red-600 dark:text-red-400" aria-hidden="true" />
            <span className="text-muted-foreground">Shell ID:</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{shell_id}</code>
          </div>
        </div>
      )}
      renderContent={() => {
        if (!toolResult) return null;

        return (
          <div className="px-2 pb-2">
            {!isError ? (
              <div className="text-xs text-success-foreground bg-success/10 border border-success/20 rounded p-2">
                Background process terminated successfully
              </div>
            ) : (
              <div className="text-xs text-destructive-foreground bg-destructive/10 border border-destructive/30 rounded p-2 font-mono">
                {typeof toolResult.content === 'object'
                  ? JSON.stringify(toolResult.content, null, 2)
                  : toolResult.content}
              </div>
            )}
          </div>
        );
      }}
    />
  );
}
