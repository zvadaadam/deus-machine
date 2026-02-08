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
import { CopyButton } from "../components/CopyButton";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";

export function GrepToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { pattern, path, output_mode, glob, type: fileType } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

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
      icon={
        <SearchCode
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Grep)}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <span
            className={cn(
              chatTheme.blocks.tool.contentHierarchy.emphasis,
              "bg-info/15 text-info rounded px-2 py-0.5 font-mono"
            )}
          >
            {pattern}
          </span>
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
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
                chatTheme.blocks.tool.content,
                "scrollbar-vibrancy max-h-[300px] overflow-y-auto",
                isError
                  ? "bg-destructive/10 text-destructive border-destructive/30 border"
                  : "bg-muted/50 text-foreground border-border border"
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
