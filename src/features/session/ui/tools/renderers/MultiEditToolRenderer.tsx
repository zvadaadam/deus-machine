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

interface Edit {
  old_string: string;
  new_string: string;
}

export function MultiEditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const file_path = (toolUse.input?.file_path as string) ?? "";
  const edits = toolUse.input?.edits as Edit[] | undefined;
  const editCount = edits?.length || 0;
  const fileName = file_path ? file_path.split("/").pop() || file_path : "unknown";

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
      renderSummary={() => (
        <>
          <span className={cn(chatTheme.blocks.tool.contentHierarchy.emphasis, "font-mono")}>
            {fileName}
          </span>
          <span className={chatTheme.blocks.tool.contentHierarchy.metadata}>
            {" "}
            &bull; {editCount} edit{editCount !== 1 ? "s" : ""}
          </span>
        </>
      )}
      renderContent={() => {
        if (!edits || edits.length === 0) {
          return (
            <div className="text-muted-foreground px-2 pb-2 text-xs italic">No edits provided</div>
          );
        }

        return (
          <div className="space-y-3 px-2 pb-2">
            {edits.map((edit: Edit, index: number) => (
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
                  fileName={file_path}
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
