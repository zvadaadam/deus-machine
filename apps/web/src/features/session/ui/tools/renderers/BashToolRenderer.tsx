import { Terminal } from "lucide-react";
import { BaseToolRenderer, ToolSummaryChip } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";

export function BashToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { command, description } = toolUse.input ?? {};
  const commandText = typeof command === "string" ? command : "";
  const descriptionText = typeof description === "string" ? description : "";
  const commandPreview = commandText || "...";

  return (
    <BaseToolRenderer
      toolName="Bash"
      icon={<Terminal className={cn(TOOL_ICON_CLS, TOOL_COLORS.Bash)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      showContentOnError
      renderSummary={() => (
        <>
          {descriptionText ? (
            <>
              <ToolSummaryChip tone="bare">{descriptionText}</ToolSummaryChip>
              <span className={cn("text-muted-foreground text-sm font-normal", "font-mono")}>
                {" → "}
                {commandPreview}
              </span>
            </>
          ) : (
            <ToolSummaryChip tone="primary">{commandPreview}</ToolSummaryChip>
          )}
        </>
      )}
      renderContent={({ toolResult: currentToolResult }) => {
        if (!currentToolResult) return null;

        const output =
          typeof currentToolResult.content === "object"
            ? JSON.stringify(currentToolResult.content, null, 2)
            : currentToolResult.content;

        return (
          <pre
            className={cn(
              "text-foreground font-mono text-sm leading-5",
              "overflow-x-auto rounded-lg px-3 py-2 whitespace-pre-wrap",
              "chat-scroll-contain max-h-[400px] overflow-y-auto border",
              "bg-muted/80 text-foreground border-border/60"
            )}
          >
            <code>
              <span className="text-success font-semibold">$ {commandText || "..."}</span>
              {"\n"}
              {output}
            </code>
          </pre>
        );
      }}
    />
  );
}
