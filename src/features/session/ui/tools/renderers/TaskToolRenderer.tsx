/**
 * Task Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Task tool (Agent spawning)
 * Displays sub-agent tasks with description and detailed prompt
 *
 * BEFORE: 141 LOC
 * AFTER: ~85 LOC
 */

import { Bot } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";

export function TaskToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { description, prompt, subagent_type } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  // Parse result if it's an object
  const result =
    toolResult && !isError
      ? typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content, null, 2)
      : "";

  const hasResult = result && result.trim().length > 0;

  return (
    <BaseToolRenderer
      toolName="Spawn Agent"
      icon={
        <Bot
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Task)}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className={cn(chatTheme.blocks.tool.contentHierarchy.summary, "font-mono")}>
          {description || subagent_type || "Running agent"}
        </span>
      )}
      renderContent={() => (
        <div className="space-y-2 px-2 pb-2">
          {/* Agent prompt */}
          {prompt && (
            <div className="bg-muted/50 border-border max-h-60 overflow-y-auto rounded border p-2 text-xs">
              <pre className="m-0 font-mono break-words whitespace-pre-wrap">{prompt}</pre>
            </div>
          )}

          {/* Agent result */}
          {hasResult && (
            <div className="bg-muted/50 border-border mt-2 max-h-60 overflow-y-auto rounded border p-2 text-xs">
              <pre className="m-0 font-mono break-words whitespace-pre-wrap">{result}</pre>
            </div>
          )}
        </div>
      )}
    />
  );
}
