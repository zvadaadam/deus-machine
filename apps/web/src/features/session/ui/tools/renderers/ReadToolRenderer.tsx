import { FileText } from "lucide-react";
import { BaseToolRenderer, CodeBlock, ToolFileLink } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { detectLanguageFromPath } from "../utils/detectLanguage";
import { TOOL_ICON_CLS, TOOL_ICON_MUTED_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";

export function ReadToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { file_path, offset } = toolUse.input ?? {};
  const safeFilePath = typeof file_path === "string" ? file_path : "";
  const language = safeFilePath ? detectLanguageFromPath(safeFilePath) : undefined;

  const rawContent =
    !toolResult || toolResult.is_error
      ? ""
      : typeof toolResult.content === "object"
        ? JSON.stringify(toolResult.content, null, 2)
        : toolResult.content;
  const normalizedRead = normalizeReadResult(rawContent, typeof offset === "number" ? offset : 0);
  const lineCount = normalizedRead.code ? normalizedRead.code.split("\n").length : null;

  return (
    <BaseToolRenderer
      toolName="Read"
      icon={<FileText className={cn(TOOL_ICON_CLS, TOOL_ICON_MUTED_CLS)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      defaultExpanded={false}
      renderSummary={() => (
        <>
          <ToolFileLink path={safeFilePath} target="files" />
          {lineCount && (
            <span className="text-muted-foreground text-sm font-normal"> • {lineCount} lines</span>
          )}
        </>
      )}
      renderContent={() => {
        if (!normalizedRead.code) return null;

        return (
          <CodeBlock
            code={normalizedRead.code}
            language={language}
            showLineNumbers={true}
            startingLineNumber={normalizedRead.lineNumberStart}
            maxHeight="400px"
          />
        );
      }}
    />
  );
}

function normalizeReadResult(rawContent: string, offset: number) {
  if (!rawContent) {
    return { code: "", lineNumberStart: offset + 1 };
  }

  const lines = rawContent.replace(/\r\n?/g, "\n").split("\n");
  const candidateLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
  const matches = candidateLines.map((line) => line.match(/^\s*(\d+)(?:\s+(.*))?$/));

  const numberedPrefixCount = matches.filter(Boolean).length;
  const expectedStart = offset + 1;
  const startsAtOffset = matches[0] ? Number(matches[0][1]) === expectedStart : false;
  const isSequential =
    candidateLines.length > 0 &&
    matches.length === candidateLines.length &&
    matches.every((match, index) => match && Number(match[1]) === expectedStart + index);

  if (numberedPrefixCount >= 3 && startsAtOffset && isSequential) {
    const stripped = candidateLines
      .map((line) => {
        const match = line.match(/^\s*\d+(?:\s+(.*))?$/);
        return match?.[1] ?? "";
      })
      .join("\n");

    return { code: stripped, lineNumberStart: expectedStart };
  }

  return { code: rawContent, lineNumberStart: expectedStart };
}
