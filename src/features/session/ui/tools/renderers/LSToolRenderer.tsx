/**
 * LS Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the LS tool (list directory contents)
 * Shows directory path and file listings
 *
 * BEFORE: 154 LOC
 * AFTER: ~95 LOC
 */

import { FolderOpen, File, Folder } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";

export function LSToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { path } = toolUse.input ?? {};
  const isError = toolResult?.is_error;

  // Parse directory listing
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

  // Determine if item is likely a directory (ends with /)
  const isDirectory = (item: string) => item.endsWith("/");

  // Extract directory name from path
  const dirName = path?.split("/").pop() || path || "unknown";

  return (
    <BaseToolRenderer
      toolName="LS"
      icon={
        <FolderOpen
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.LS)}
        />
      }
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <span
            className={cn(
              chatTheme.blocks.tool.contentHierarchy.emphasis,
              "bg-muted/60 rounded-md px-1.5 py-0.5 font-mono"
            )}
          >
            {dirName}
          </span>
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
            {" "}
            • {hasListings ? `${itemCount} item${itemCount !== 1 ? "s" : ""}` : "empty"}
          </span>
        </>
      )}
      renderContent={() => {
        // Empty directory message
        if (!hasListings) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">Directory is empty</div>
          );
        }

        // Directory contents
        return (
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {listings.map((item, index) => {
              const isDir = isDirectory(item);
              const cleanItem = item.replace(/\/$/, ""); // Remove trailing slash for display

              return (
                <div
                  key={index}
                  className="bg-muted/50 hover:bg-muted group flex items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors"
                >
                  {isDir ? (
                    <Folder className="text-info h-3 w-3 flex-shrink-0" aria-hidden="true" />
                  ) : (
                    <File
                      className="text-muted-foreground h-3 w-3 flex-shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="flex-1 break-all">{cleanItem}</span>
                  {isDir && (
                    <span className="text-muted-foreground text-2xs opacity-60 transition-opacity group-hover:opacity-100">
                      DIR
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        );
      }}
    />
  );
}
