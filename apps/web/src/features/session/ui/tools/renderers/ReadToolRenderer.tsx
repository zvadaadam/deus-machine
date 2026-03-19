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
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";

export function ReadToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { file_path, offset, limit } = toolUse.input ?? {};
  const safeFilePath = typeof file_path === "string" ? file_path : "";
  const language = safeFilePath ? detectLanguageFromPath(safeFilePath) : undefined;

  // Extract filename from path
  const fileName = safeFilePath ? safeFilePath.split("/").pop() || safeFilePath : "unknown";

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
      icon={<FileText className={cn(TOOL_ICON_CLS, TOOL_COLORS.Read)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      defaultExpanded={false}
      renderSummary={() => (
        <>
          <span
            className={cn(
              "text-foreground/80 rounded-sm px-1.5 py-0.5 font-mono text-sm font-normal",
              "bg-muted/60 rounded-md px-1.5 py-0.5 font-mono"
            )}
          >
            {fileName}
          </span>
          {lineCount && (
            <span className="text-muted-foreground text-sm font-normal"> • {lineCount} lines</span>
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
