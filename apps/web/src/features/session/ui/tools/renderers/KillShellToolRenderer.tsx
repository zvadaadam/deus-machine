import { XCircle } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";

export function KillShellToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { shell_id } = toolUse.input ?? {};

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
      renderContent={() =>
        !isLoading && (
          <div className="px-2 pb-2">
            <div className="text-success-foreground bg-success/10 border-success/20 rounded-md border p-2 text-xs">
              Background process terminated successfully
            </div>
          </div>
        )
      }
    />
  );
}
