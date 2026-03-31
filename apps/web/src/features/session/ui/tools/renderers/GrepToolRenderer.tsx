/**
 * Grep Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Grep tool (search results)
 *
 * BEFORE: 138 LOC
 * AFTER: ~65 LOC
 */

import { SearchCode } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";

export function GrepToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { pattern, path, output_mode, glob, type: fileType } = toolUse.input ?? {};

  // Count matches from result
  const getMatchCount = () => {
    if (!toolResult || toolResult.is_error) return null;
    const content = typeof toolResult.content === "string" ? toolResult.content : "";
    if (!content) return 0;
    // For files_with_matches mode, count lines (each line is a file)
    if (output_mode === "files_with_matches") {
      return content
        .trim()
        .split("\n")
        .filter((line) => line.trim()).length;
    }
    // For content mode, count non-empty lines
    return content
      .trim()
      .split("\n")
      .filter((line) => line.trim()).length;
  };

  const matchCount = getMatchCount();
  const pathPreview = path ? path.split("/").pop() || path : "all files";

  return (
    <BaseToolRenderer
      toolName="Grep"
      icon={<SearchCode className={cn(TOOL_ICON_CLS, TOOL_COLORS.Grep)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <span
            className={cn(
              "text-foreground/80 rounded-sm px-1.5 py-0.5 font-mono text-sm font-normal",
              "bg-info/15 text-info rounded-md px-2 py-0.5 font-mono"
            )}
          >
            {pattern}
          </span>
          <span className="text-muted-foreground text-sm font-normal">
            {" "}
            in {glob || fileType || pathPreview}
            {matchCount !== null && ` • ${matchCount} match${matchCount !== 1 ? "es" : ""}`}
          </span>
        </>
      )}
      renderContent={({ toolResult }) => {
        // Guard against undefined toolResult
        if (!toolResult || !toolResult.content) {
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
              {typeof toolResult.content === "object"
                ? JSON.stringify(toolResult.content, null, 2)
                : toolResult.content}
            </pre>
          </div>
        );
      }}
    />
  );
}
