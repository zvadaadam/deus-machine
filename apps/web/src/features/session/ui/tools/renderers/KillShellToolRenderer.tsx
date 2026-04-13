import { XCircle } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";

export function KillShellToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { shell_id } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  return (
    <BaseToolRenderer
      toolName="Kill Background Process"
      icon={<XCircle className={cn(TOOL_ICON_CLS, TOOL_COLORS.KillShell)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className={cn("text-muted-foreground truncate text-sm", "font-mono")}>
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
              <div className="text-muted-foreground border-border/60 bg-muted/50 rounded-md border p-2 font-mono text-xs break-words whitespace-pre-wrap">
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
