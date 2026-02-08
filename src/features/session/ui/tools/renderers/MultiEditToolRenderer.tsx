/**
 * MultiEdit Tool Renderer
 *
 * Renders multiple edits to one file, each as a proper unified diff
 * powered by @pierre/diffs.
 */

import { FilePenLine } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { UnifiedDiff } from "../components/UnifiedDiff";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { chatTheme } from "../../theme";
import { computeDiffStats } from "../utils/computeDiffStats";

interface Edit {
  old_string: string;
  new_string: string;
}

export function MultiEditToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const { file_path, edits } = toolUse.input ?? {};
  const safeFilePath = typeof file_path === "string" ? file_path : "";
  const safeEdits: Edit[] = Array.isArray(edits)
    ? edits.filter(
        (edit): edit is Edit =>
          !!edit &&
          typeof edit === "object" &&
          typeof edit.old_string === "string" &&
          typeof edit.new_string === "string"
      )
    : [];
  const editCount = safeEdits.length;
  const fileName = safeFilePath ? safeFilePath.split("/").pop() || safeFilePath : "unknown";

  // Aggregate diff stats across all edits
  const totalStats = safeEdits.reduce(
    (acc, edit) => {
      const stats = computeDiffStats(edit.old_string, edit.new_string);
      return { added: acc.added + stats.added, removed: acc.removed + stats.removed };
    },
    { added: 0, removed: 0 }
  );

  return (
    <BaseToolRenderer
      toolName="MultiEdit"
      icon={
        <FilePenLine
          className={cn(
            chatTheme.tools.iconSize,
            chatTheme.tools.iconBase,
            chatTheme.tools.MultiEdit
          )}
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
              "bg-muted/60 rounded px-1.5 py-0.5 font-mono"
            )}
          >
            {fileName}
          </span>
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
            {" "}
            • {editCount} edit{editCount !== 1 ? "s" : ""}
          </span>
          {(totalStats.added > 0 || totalStats.removed > 0) && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] tabular-nums">
              <span className="text-success">+{totalStats.added}</span>
              <span className="text-destructive">-{totalStats.removed}</span>
            </span>
          )}
        </>
      )}
      renderContent={() => {
        if (safeEdits.length === 0) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">No edits provided</div>
          );
        }

        return (
          <div className="space-y-3 px-2 pb-2">
            {safeEdits.map((edit: Edit, index: number) => (
              <div key={index} className="space-y-1">
                {editCount > 1 && (
                  <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                    <span className="bg-muted rounded px-1.5 py-0.5">
                      Edit {index + 1}/{editCount}
                    </span>
                  </div>
                )}
                <UnifiedDiff
                  oldString={edit.old_string}
                  newString={edit.new_string}
                  fileName={safeFilePath}
                  maxHeight="300px"
                />
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}
