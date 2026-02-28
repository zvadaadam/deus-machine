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
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";

export function WriteToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { file_path, content } = toolUse.input ?? {};
  const safeFilePath = typeof file_path === "string" ? file_path : "";
  const safeContent = typeof content === "string" ? content : "";
  const fileName = safeFilePath ? (safeFilePath.split("/").pop() ?? safeFilePath) : "unknown";
  const lineCount = safeContent ? safeContent.split("\n").length : 0;
  const language = safeFilePath ? detectLanguageFromPath(safeFilePath) : undefined;

  return (
    <BaseToolRenderer
      toolName="Write"
      icon={<FilePlus className={cn(TOOL_ICON_CLS, TOOL_COLORS.Write)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
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
          <span className="text-muted-foreground text-sm font-normal"> • {lineCount} lines</span>
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
