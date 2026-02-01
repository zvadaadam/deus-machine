/**
 * BashOutput Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the BashOutput tool
 * Monitors and displays output from background bash processes
 *
 * BEFORE: 140 LOC
 * AFTER: ~75 LOC
 */

import { Terminal, Activity } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";

export function BashOutputToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { bash_id, filter } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  // Parse output content
  const output =
    toolResult && !isError
      ? typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content, null, 2)
      : "";

  const hasOutput = output && output.trim().length > 0;
  const lineCount = hasOutput ? output.split("\n").length : 0;

  return (
    <BaseToolRenderer
      toolName="Process"
      icon={
        <Activity
          className={cn(
            chatTheme.tools.iconSize,
            chatTheme.tools.iconBase,
            chatTheme.tools.BashOutput
          )}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <span className="font-mono">
          {bash_id?.substring(0, 6) ?? "..."}
          {filter ? ` • filtered` : ""} •{" "}
          {hasOutput ? `${lineCount} line${lineCount !== 1 ? "s" : ""}` : "no output"}
        </span>
      )}
      renderContent={() => {
        // No output message
        if (!hasOutput) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">
              No new output from process
            </div>
          );
        }

        // Output display
        return (
          <div className="px-2 pb-2">
            <div className="text-muted-foreground mb-1 text-xs">Output:</div>
            <div
              className={cn(
                "overflow-x-auto rounded p-3 font-mono text-xs",
                "bg-sidebar-accent/90 text-success",
                "border-border border shadow-sm",
                "max-h-96 overflow-y-auto"
              )}
            >
              <pre className="m-0 break-words whitespace-pre-wrap">{output}</pre>
            </div>
          </div>
        );
      }}
    />
  );
}
