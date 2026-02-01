/**
 * Write Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Write tool (creating new files).
 *
 * BEFORE: 105 LOC (header, animation, error, code preview)
 * AFTER: ~30 LOC (only unique code preview logic!)
 */

import { FilePlus } from "lucide-react";
import { BaseToolRenderer, CodeBlock, FilePathDisplay } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { detectLanguageFromPath } from "../utils/detectLanguage";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";

export function WriteToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, content } = toolUse.input ?? {};
  const safeFilePath = typeof file_path === "string" ? file_path : "";
  const safeContent = typeof content === "string" ? content : "";
  const fileName = safeFilePath ? (safeFilePath.split("/").pop() ?? safeFilePath) : "unknown";
  const lineCount = safeContent ? safeContent.split("\n").length : 0;
  const language = safeFilePath ? detectLanguageFromPath(safeFilePath) : undefined;

  return (
    <BaseToolRenderer
      toolName="Write"
      icon={
        <FilePlus
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Write)}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
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
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
            {" "}
            • {lineCount} lines
          </span>
        </>
      )}
      renderContent={() => (
        <CodeBlock
          code={safeContent}
          language={language}
          showLineNumbers={true}
          maxHeight="300px"
        />
      )}
    />
  );
}
