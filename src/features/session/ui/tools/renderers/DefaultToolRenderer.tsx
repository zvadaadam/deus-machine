/**
 * Default Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Fallback renderer for unknown/unsupported tools.
 *
 * BEFORE: 70 LOC
 * AFTER: ~25 LOC
 */

import { Wrench } from "lucide-react";
import { BaseToolRenderer } from "../components";
import type { ToolRendererProps } from "../../chat-types";

export function DefaultToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  // Extract first input value as preview (if available)
  const firstInputKey = Object.keys(toolUse.input || {})[0];
  const firstInputValue = firstInputKey
    ? String(toolUse.input[firstInputKey]).substring(0, 40)
    : "";

  return (
    <BaseToolRenderer
      toolName={toolUse.name || "Unknown Tool"}
      icon={<Wrench className="text-muted-foreground/70 h-4 w-4" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() =>
        firstInputValue ? (
          <span className="text-muted-foreground truncate font-mono text-[12px]">
            {firstInputValue}
          </span>
        ) : undefined
      }
      renderContent={({ toolUse, toolResult }) => {
        return (
          <div className="space-y-3 px-2 pb-2">
            {/* Input */}
            <div>
              <div className="text-muted-foreground mb-1 text-xs font-semibold">Input:</div>
              <pre className="bg-muted/60 border-border/60 max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
                {JSON.stringify(toolUse.input, null, 2)}
              </pre>
            </div>

            {/* Output */}
            {toolResult && (
              <div>
                <div className="text-muted-foreground mb-1 text-xs font-semibold">Output:</div>
                <pre className="bg-muted/60 border-border/60 max-h-[200px] overflow-x-auto overflow-y-auto rounded-lg border p-3 font-mono text-xs">
                  {typeof toolResult.content === "object"
                    ? JSON.stringify(toolResult.content, null, 2)
                    : toolResult.content}
                </pre>
              </div>
            )}
          </div>
        );
      }}
    />
  );
}
