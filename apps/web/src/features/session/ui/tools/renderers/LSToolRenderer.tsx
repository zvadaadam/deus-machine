import { File, Folder, FolderOpen } from "lucide-react";
import { BaseToolRenderer, ToolResultList, ToolResultRow, ToolSummaryChip } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";
import { getPathLeaf } from "../utils/getPathLeaf";

export function LSToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { path } = toolUse.input ?? {};
  const safePath = typeof path === "string" ? path : "";
  const isError = toolResult?.is_error;

  const parseListings = (content: string): string[] => {
    if (!content || content.trim() === "") {
      return [];
    }
    return content.split("\n").filter((line) => line.trim().length > 0);
  };

  const listings =
    toolResult && !isError
      ? parseListings(
          typeof toolResult.content === "string"
            ? toolResult.content
            : JSON.stringify(toolResult.content)
        )
      : [];

  const hasListings = listings.length > 0;
  const itemCount = listings.length;
  const dirName = getPathLeaf(safePath);

  return (
    <BaseToolRenderer
      toolName="LS"
      icon={<FolderOpen className={cn(TOOL_ICON_CLS, TOOL_COLORS.LS)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <ToolSummaryChip>{dirName}</ToolSummaryChip>
          <span className="text-muted-foreground text-sm font-normal tabular-nums">
            {" "}
            • {hasListings ? `${itemCount} item${itemCount !== 1 ? "s" : ""}` : "empty"}
          </span>
        </>
      )}
      renderContent={() => {
        if (!hasListings) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">Directory is empty</div>
          );
        }

        return (
          <ToolResultList>
            {listings.map((item, index) => {
              const normalizedItem = item.replace(/\\/g, "/");
              const isDirectory = normalizedItem.endsWith("/");
              const cleanItem = normalizedItem.replace(/\/$/, "");

              return (
                <ToolResultRow key={item + index} title={item}>
                  {isDirectory ? (
                    <Folder className="text-info h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  ) : (
                    <File
                      className="text-muted-foreground h-3.5 w-3.5 flex-shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1 font-mono text-xs leading-5">{cleanItem}</div>
                  {isDirectory && (
                    <span className="bg-info/10 text-info rounded-sm px-1.5 py-0.5 text-[10px] font-medium tracking-[0.08em] uppercase">
                      Folder
                    </span>
                  )}
                </ToolResultRow>
              );
            })}
          </ToolResultList>
        );
      }}
    />
  );
}
