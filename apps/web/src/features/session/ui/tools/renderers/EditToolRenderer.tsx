import { BaseToolRenderer, ToolFileLink, ToolFileTypeIcon, UnifiedDiff } from "../components";
import type { ToolRendererProps } from "../../chat-types";
import { computeDiffStats } from "../utils/computeDiffStats";

export function EditToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const input = toolUse?.input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  const fileLabel = filePath || "unknown file";
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";
  const { added, removed } = computeDiffStats(oldString, newString);

  return (
    <BaseToolRenderer
      toolName="Edit"
      icon={<ToolFileTypeIcon path={filePath} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <>
          {filePath ? (
            <ToolFileLink path={filePath} target="changes" />
          ) : (
            <span className="text-muted-foreground truncate font-mono">{fileLabel}</span>
          )}
          {(added > 0 || removed > 0) && (
            <span className="ml-1.5 inline-flex items-center gap-1 tabular-nums">
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
          fileName={fileLabel}
          maxHeight="400px"
          className="w-full"
        />
      )}
    />
  );
}
