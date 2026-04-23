import { BaseToolRenderer, ToolFileLink, ToolFileTypeIcon } from "../components";
import { UnifiedDiff } from "../components/UnifiedDiff";
import type { ToolRendererProps } from "../../chat-types";
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
      icon={<ToolFileTypeIcon path={safeFilePath} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          <ToolFileLink path={safeFilePath} target="changes" />
          <span className="text-muted-foreground text-sm font-normal">
            {" "}
            • {editCount} edit{editCount !== 1 ? "s" : ""}
          </span>
          {(totalStats.added > 0 || totalStats.removed > 0) && (
            <span className="ml-1.5 inline-flex items-center gap-1 tabular-nums">
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
          <div className="w-full space-y-4 pb-1">
            {safeEdits.map((edit, index) => (
              <div key={index} className="w-full space-y-1.5">
                {editCount > 1 && (
                  <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium">
                    <span className="bg-muted rounded-md px-1.5 py-0.5">
                      Edit {index + 1}/{editCount}
                    </span>
                  </div>
                )}
                <UnifiedDiff
                  oldString={edit.old_string}
                  newString={edit.new_string}
                  fileName={safeFilePath}
                  maxHeight="320px"
                  className="w-full"
                />
              </div>
            ))}
          </div>
        );
      }}
    />
  );
}
