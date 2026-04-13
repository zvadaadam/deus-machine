import { SearchCode } from "lucide-react";
import { BaseToolRenderer, ToolSummaryChip } from "../components";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { getPathLeaf } from "../utils/getPathLeaf";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";

export function GrepToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { pattern, path, output_mode, glob, type: fileType } = toolUse.input ?? {};
  const patternText = typeof pattern === "string" ? pattern : "pattern";
  const pathPreview = getPathLeaf(typeof path === "string" ? path : undefined, "all files");
  const scopeLabel =
    typeof glob === "string" && glob
      ? glob
      : typeof fileType === "string" && fileType
        ? fileType
        : pathPreview;

  const getMatchCount = () => {
    if (!toolResult || toolResult.is_error) return null;
    const content = typeof toolResult.content === "string" ? toolResult.content : "";
    if (!content) return 0;
    return content
      .trim()
      .split("\n")
      .filter((line) => line.trim()).length;
  };

  const matchCount = getMatchCount();

  return (
    <BaseToolRenderer
      toolName="Grep"
      icon={<SearchCode className={cn(TOOL_ICON_CLS, TOOL_COLORS.Grep)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <ToolSummaryChip tone="info" className="px-2">
            {patternText}
          </ToolSummaryChip>
          <span className="text-muted-foreground text-sm font-normal">
            {" "}
            in {scopeLabel}
            {matchCount !== null && ` • ${matchCount} match${matchCount !== 1 ? "es" : ""}`}
          </span>
        </>
      )}
      renderContent={({ toolResult: currentToolResult }) => {
        if (!currentToolResult?.content) {
          return null;
        }

        return (
          <div className="px-2 pb-2">
            <pre
              className={cn(
                "overflow-x-auto rounded p-2 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap",
                "chat-scroll-contain max-h-[300px] overflow-y-auto",
                "bg-muted/50 text-foreground border-border border"
              )}
            >
              {typeof currentToolResult.content === "object"
                ? JSON.stringify(currentToolResult.content, null, 2)
                : currentToolResult.content}
            </pre>
          </div>
        );
      }}
    />
  );
}
