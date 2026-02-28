/**
 * Edit Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Edit tool (file editing).
 * Shows file path and old_string → new_string changes.
 *
 * BEFORE: 150 LOC (header, animation, error, unique diff view)
 * AFTER: ~40 LOC (only unique diff view logic!)
 */

import { FileEdit } from "lucide-react";
import { BaseToolRenderer, UnifiedDiff } from "../components";
import { chatTheme } from "../../theme";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { computeDiffStats } from "../utils/computeDiffStats";

export function EditToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse?.input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "unknown file";
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";

  // Extract filename for collapsed summary
  const fileName = filePath.split("/").pop() || filePath;

  const { added, removed } = computeDiffStats(oldString, newString);

  return (
    <BaseToolRenderer
      toolName="Edit"
      icon={
        <FileEdit
          className={cn(chatTheme.tools.iconSize, chatTheme.tools.iconBase, chatTheme.tools.Edit)}
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
            {fileName}
          </span>
          {(added > 0 || removed > 0) && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-xs tabular-nums">
              <span className="text-success">+{added}</span>
              <span className="text-destructive">-{removed}</span>
            </span>
          )}
        </>
      )}
      renderContent={() => (
        <UnifiedDiff
          oldString={oldString}
          newString={newString}
          fileName={filePath}
          maxHeight="400px"
        />
      )}
    />
  );
}
