/**
 * WebSearch Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the WebSearch tool
 * Displays web search queries and results
 *
 * BEFORE: 161 LOC
 * AFTER: ~90 LOC
 */

import { Search } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import { chatTheme } from "../../theme";
import type { ToolRendererProps } from "../../chat-types";

export function WebSearchToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { query, allowed_domains, blocked_domains } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  // Parse result content
  const result =
    toolResult && !isError
      ? typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content, null, 2)
      : "";

  const hasResult = result && result.trim().length > 0;

  // Build filter info for preview
  const filterInfo = [];
  if (allowed_domains?.length) filterInfo.push(`only: ${allowed_domains.join(", ")}`);
  if (blocked_domains?.length) filterInfo.push(`exclude: ${blocked_domains.join(", ")}`);
  const filterText = filterInfo.length ? ` • ${filterInfo.join(" • ")}` : "";

  return (
    <BaseToolRenderer
      toolName="Web Search"
      icon={
        <Search
          className={cn(
            chatTheme.tools.iconSize,
            chatTheme.tools.iconBase,
            chatTheme.tools.WebSearch
          )}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className={chatTheme.blocks.tool.contentHierarchy.summary}>
          "{query}"{filterText}
        </span>
      )}
      renderContent={() => {
        // No result message
        if (!hasResult) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">No results found</div>
          );
        }

        // Result display
        return (
          <div className="px-2 pb-2">
            <div
              className={cn(
                chatTheme.blocks.tool.contentHierarchy.mono,
                "overflow-x-auto rounded-md px-3 py-2",
                "bg-muted/50 border-border border",
                "max-h-96 overflow-y-auto"
              )}
            >
              <pre className="m-0 break-words whitespace-pre-wrap">{result}</pre>
            </div>
          </div>
        );
      }}
    />
  );
}
