import { Search } from "lucide-react";
import { BaseToolRenderer, ToolResultList, ToolResultRow, ToolSummaryChip } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_ICON_CLS, TOOL_ICON_MUTED_CLS } from "../toolColors";
import { extractText } from "./shared";
import { cn } from "@/shared/lib/utils";

type ToolReference = {
  type: "tool_reference";
  tool_name: string;
};

function parseToolReferences(content: unknown): string[] {
  const text = extractText(content);
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is ToolReference => item?.type === "tool_reference")
        .map((item) => item.tool_name);
    }
  } catch {
    // not JSON — ignore
  }

  return [];
}

export function ToolSearchToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { query } = toolUse.input ?? {};
  const queryText = typeof query === "string" ? query : "";
  const isError = toolResult?.is_error;

  const tools = toolResult && !isError ? parseToolReferences(toolResult.content) : [];
  const resultCount = tools.length;

  return (
    <BaseToolRenderer
      toolName="ToolSearch"
      icon={<Search className={cn(TOOL_ICON_CLS, TOOL_ICON_MUTED_CLS)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <ToolSummaryChip tone="info">{queryText}</ToolSummaryChip>
          {toolResult && !isError && (
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {" "}
              &bull; {resultCount} tool{resultCount !== 1 ? "s" : ""}
            </span>
          )}
        </>
      )}
      renderContent={() => {
        if (!tools.length) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">
              No tools matched the query
            </div>
          );
        }

        return (
          <ToolResultList>
            {tools.map((tool, index) => (
              <ToolResultRow key={tool + index} title={tool}>
                <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-[11px] tabular-nums">
                  {index + 1}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs leading-5">
                  {tool}
                </span>
              </ToolResultRow>
            ))}
          </ToolResultList>
        );
      }}
    />
  );
}
