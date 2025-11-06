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

export function ReadToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, offset, limit } = toolUse.input;

  // Extract filename from path
  const fileName = file_path.split("/").pop() || file_path;

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
      icon={<FileText className="text-info/70 h-4 w-4 flex-shrink-0" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false}
      renderSummary={() => (
        <>
          <span className="bg-muted/60 rounded px-2 py-0.5 font-mono text-xs font-medium">
            {fileName}
          </span>
          {lineCount && <span className="text-muted-foreground text-xs"> • {lineCount} lines</span>}
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
            language={detectLanguageFromPath(file_path)}
            showLineNumbers={true}
            maxHeight="400px"
          />
        );
      }}
    />
  );
}
