import { Activity } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";

export function BashOutputToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
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
      icon={<Activity className={cn(TOOL_ICON_CLS, TOOL_COLORS.BashOutput)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      showContentOnError
      renderSummary={() => (
        <span className={cn("text-muted-foreground truncate text-sm", "font-mono")}>
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
          <div
            className={cn(
              "text-foreground font-mono text-sm leading-5",
              "overflow-x-auto rounded-md px-3 py-2",
              "bg-muted/50 border-border border",
              "chat-scroll-contain max-h-96 overflow-y-auto"
            )}
          >
            <pre className="m-0 break-words whitespace-pre-wrap">{output}</pre>
          </div>
        );
      }}
    />
  );
}
