import { FileSearch } from "lucide-react";
import { BaseToolRenderer, ToolResultList, ToolResultRow, ToolSummaryChip } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { getPathLeaf } from "../utils/getPathLeaf";
import { cn } from "@/shared/lib/utils";

function splitPathForDisplay(path: string) {
  const normalized = path.replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || normalized;
  const parent = parts.slice(0, -1).join("/");
  return { name, parent };
}

export function GlobToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { pattern, path } = toolUse.input ?? {};
  const patternText = typeof pattern === "string" ? pattern : "*";
  const scopedPath = typeof path === "string" ? path : "";
  const scopeName = scopedPath ? getPathLeaf(scopedPath, scopedPath) : "";
  const isError = toolResult?.is_error;

  const parseResults = (content: string): string[] => {
    if (!content || content.trim() === "" || content.includes("No files found")) {
      return [];
    }
    return content.split("\n").filter((line) => line.trim().length > 0);
  };

  const files =
    toolResult && !isError
      ? parseResults(
          typeof toolResult.content === "string"
            ? toolResult.content
            : JSON.stringify(toolResult.content)
        )
      : [];

  const hasResults = files.length > 0;
  const resultCount = files.length;

  return (
    <BaseToolRenderer
      toolName="Glob"
      icon={<FileSearch className={cn(TOOL_ICON_CLS, TOOL_COLORS.Glob)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <ToolSummaryChip tone="info">{patternText}</ToolSummaryChip>
          {scopeName && <ToolSummaryChip>{scopeName}</ToolSummaryChip>}
          <span className="text-muted-foreground text-sm font-normal tabular-nums">
            {" "}
            • {hasResults ? `${resultCount} file${resultCount !== 1 ? "s" : ""}` : "no files"}
          </span>
        </>
      )}
      renderContent={() => {
        if (!hasResults) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">
              No files matched the pattern
            </div>
          );
        }

        return (
          <ToolResultList>
            {files.map((file, index) => {
              const { name, parent } = splitPathForDisplay(file);

              return (
                <ToolResultRow key={file + index} title={file}>
                  <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-[11px] tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 font-mono">
                    <div className="text-foreground truncate text-xs leading-5">{name}</div>
                    {parent && (
                      <div className="text-muted-foreground/70 truncate text-[11px] leading-4">
                        {parent}
                      </div>
                    )}
                  </div>
                </ToolResultRow>
              );
            })}
          </ToolResultList>
        );
      }}
    />
  );
}
