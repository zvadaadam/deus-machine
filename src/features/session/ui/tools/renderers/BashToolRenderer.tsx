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
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";

export function BashToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { command, description } = toolUse.input ?? {};
  const commandText = typeof command === "string" ? command : "";

  // Truncate command more aggressively when description exists (command is secondary)
  const commandPreview = (() => {
    if (!commandText) return "...";
    return commandText.length > 35 ? `${commandText.slice(0, 35)}...` : commandText;
  })();

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
          {description ? (
            // Description exists: Description is hero, command is metadata
            <>
              <span className="text-foreground/80 rounded-sm px-1.5 py-0.5 font-mono text-sm font-normal">
                {description}
              </span>
              <span className={cn("text-muted-foreground text-sm font-normal", "font-mono")}>
                {" → "}
                {commandPreview}
              </span>
            </>
          ) : (
            // No description: Command is hero
            <span
              className={cn(
                "text-foreground/80 rounded-sm px-1.5 py-0.5 font-mono text-sm font-normal",
                "bg-primary/15 text-primary rounded-md px-2 py-0.5 font-mono"
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
              "text-foreground font-mono text-sm leading-5",
              "overflow-x-auto rounded-lg px-3 py-2 whitespace-pre-wrap",
              "max-h-[400px] overflow-y-auto border",
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
