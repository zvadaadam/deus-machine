/**
 * Bash Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Bash tool (shell commands).
 *
 * BEFORE: 100 LOC
 * AFTER: ~40 LOC
 */

import { Terminal } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";

export function BashToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { command, description } = toolUse.input ?? {};
  const commandText = typeof command === "string" ? command : "";
  const isError = toolResult?.is_error;

  // Truncate command more aggressively when description exists (command is secondary)
  const commandPreview = (() => {
    if (!commandText) return "...";
    return commandText.length > 35 ? `${commandText.slice(0, 35)}...` : commandText;
  })();

  return (
    <BaseToolRenderer
      toolName="Bash"
      icon={
        <Terminal
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Bash)}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <>
          {description ? (
            // Description exists: Description is hero, command is metadata
            <>
              <span className={chatTheme.blocks.tool.contentHierarchy.emphasis}>{description}</span>
              <span className={cn(chatTheme.blocks.tool.contentHierarchy.metadata, "font-mono")}>
                {" → "}
                {commandPreview}
              </span>
            </>
          ) : (
            // No description: Command is hero
            <span
              className={cn(
                chatTheme.blocks.tool.contentHierarchy.emphasis,
                "bg-primary/15 text-primary rounded px-2 py-0.5 font-mono"
              )}
            >
              {commandPreview}
            </span>
          )}
        </>
      )}
      renderContent={({ toolResult }) => {
        if (!toolResult) return null;

        // Extract output content
        const output =
          typeof toolResult.content === "object"
            ? JSON.stringify(toolResult.content, null, 2)
            : toolResult.content;

        return (
          <pre
            className={cn(
              "overflow-x-auto rounded-lg p-4 font-mono text-sm whitespace-pre-wrap",
              "max-h-[400px] overflow-y-auto border",
              isError
                ? "bg-destructive/15 text-destructive-foreground border-destructive/30"
                : "bg-muted/80 text-foreground border-border/60"
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
