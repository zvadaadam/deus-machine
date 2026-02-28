/**
 * KillShell Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the KillShell tool
 * Terminates background shell processes
 *
 * BEFORE: 94 LOC
 * AFTER: ~55 LOC
 */

import { XCircle } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";

export function KillShellToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { shell_id } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  return (
    <BaseToolRenderer
      toolName="Kill Background Process"
      icon={
        <XCircle
          className={cn(
            chatTheme.tools.iconSize,
            chatTheme.tools.iconBase,
            chatTheme.tools.KillShell
          )}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className={cn(chatTheme.blocks.tool.contentHierarchy.summary, "font-mono")}>
          shell {shell_id?.substring(0, 6) ?? "..."}
        </span>
      )}
      renderContent={() => {
        if (!toolResult) return null;

        return (
          <div className="px-2 pb-2">
            {!isError ? (
              <div className="text-success-foreground bg-success/10 border-success/20 rounded-md border p-2 text-xs">
                Background process terminated successfully
              </div>
            ) : (
              <div className="text-foreground/70 bg-destructive/5 border-destructive/15 rounded-md border p-2 font-mono text-xs">
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
