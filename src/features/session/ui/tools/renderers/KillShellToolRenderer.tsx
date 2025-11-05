/**
 * KillShell Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the KillShell tool
 * Terminates background shell processes
 *
 * BEFORE: 94 LOC
 * AFTER: ~55 LOC
 */

import { XCircle, Terminal } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";

export function KillShellToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { shell_id } = toolUse.input;
  const isError = toolResult?.is_error;

  return (
    <BaseToolRenderer
      toolName="Kill Background Process"
      icon={<XCircle className="text-muted-foreground/70 h-4 w-4" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="text-muted-foreground font-mono text-[12px]">
          shell {shell_id.substring(0, 6)}
        </span>
      )}
      renderContent={() => {
        if (!toolResult) return null;

        return (
          <div className="px-2 pb-2">
            {!isError ? (
              <div className="text-success-foreground bg-success/10 border-success/20 rounded border p-2 text-xs">
                Background process terminated successfully
              </div>
            ) : (
              <div className="text-destructive-foreground bg-destructive/10 border-destructive/30 rounded border p-2 font-mono text-xs">
                {typeof toolResult.content === "object"
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
