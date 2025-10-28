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
      icon={<XCircle className="w-4 h-4 text-muted-foreground/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono text-[12px] text-muted-foreground">
          shell {shell_id.substring(0, 6)}
        </span>
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
