/**
 * Glob Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Glob tool (file pattern matching)
 * Shows matched file paths from glob patterns
 *
 * BEFORE: 147 LOC
 * AFTER: ~90 LOC
 */

import { FileSearch } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";

export function GlobToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { pattern, path } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  // Parse results - Glob returns newline-separated file paths or "No files found"
  const parseResults = (content: string): string[] => {
    if (!content || content.trim() === "" || content.includes("No files found")) {
      return [];
    }
    return content.split("\n").filter((line) => line.trim().length > 0);
  };

  const files =
    toolResult && !isError
      ? parseResults(
          typeof toolResult.content === "string"
            ? toolResult.content
            : JSON.stringify(toolResult.content)
        )
      : [];

  const hasResults = files.length > 0;
  const resultCount = files.length;

  return (
    <BaseToolRenderer
      toolName="Glob"
      icon={
        <FileSearch
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Glob)}
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
              "bg-info/15 text-info rounded-md px-1.5 py-0.5 font-mono"
            )}
          >
            {pattern}
          </span>
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
            {path && ` in ${path}`} •{" "}
            {hasResults ? `${resultCount} file${resultCount !== 1 ? "s" : ""}` : "no files"}
          </span>
        </>
      )}
      renderContent={() => {
        // No results message
        if (!hasResults) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">
              No files matched the pattern
            </div>
          );
        }

        // File list
        return (
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {files.map((file, index) => (
              <div
                key={index}
                className="bg-muted/50 hover:bg-muted group flex items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors"
              >
                <span className="text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100">
                  {index + 1}.
                </span>
                <span className="flex-1 break-all">{file}</span>
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}
