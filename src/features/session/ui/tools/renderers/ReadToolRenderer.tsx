/**
 * Read Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Read tool (reading file contents).
 *
 * BEFORE: 115 LOC (header, animation, error, syntax highlighting)
 * AFTER: ~35 LOC (only unique syntax highlighting logic!)
 */

import { FileText } from "lucide-react";
import { BaseToolRenderer, CodeBlock, FilePathDisplay } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { detectLanguageFromPath } from "../utils/detectLanguage";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";

export function ReadToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, offset, limit } = toolUse.input ?? {};
  const language = file_path ? detectLanguageFromPath(file_path) : undefined;

  // Extract filename from path
  const fileName = file_path?.split("/").pop() || file_path || "unknown";

  // Count lines from result content
  const getLineCount = () => {
    if (!toolResult || toolResult.is_error) return null;

    const content =
      typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content, null, 2);

    return content.split("\n").length;
  };

  const lineCount = getLineCount();

  return (
    <BaseToolRenderer
      toolName="Read"
      icon={
        <FileText
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Read)}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      renderSummary={() => (
        <>
          <span
            className={cn(
              chatTheme.blocks.tool.contentHierarchy.emphasis,
              "bg-muted/60 rounded px-1.5 py-0.5 font-mono"
            )}
          >
            {fileName}
          </span>
          {lineCount && (
            <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
              {" "}
              • {lineCount} lines
            </span>
          )}
        </>
      )}
      renderContent={({ toolResult }) => {
        if (!toolResult || toolResult.is_error) return null;

        return (
          <CodeBlock
            code={
              typeof toolResult.content === "object"
                ? JSON.stringify(toolResult.content, null, 2)
                : toolResult.content
            }
            language={language}
            showLineNumbers={true}
            maxHeight="400px"
          />
        );
      }}
    />
  );
}
