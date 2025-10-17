import type { FileChangeGroup } from "../../../types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface FileChangesPanelProps {
  fileChanges: FileChangeGroup[];
  selectedFile: FileChangeGroup | null;
  onFileSelect: (file: FileChangeGroup) => void;
}

export function FileChangesPanel({
  fileChanges,
  selectedFile,
  onFileSelect,
}: FileChangesPanelProps) {
  return (
    <div className="w-80 bg-secondary/30 border-r border-border flex flex-col overflow-hidden">
      <h3 className="p-4 px-6 m-0 text-base text-foreground border-b border-border bg-background">
        Files Changed ({fileChanges.length})
      </h3>
      <div className="flex-1 overflow-y-auto p-2">
        {fileChanges.length === 0 ? (
          <p className="p-4 text-muted-foreground text-center text-sm">No file changes yet</p>
        ) : (
          fileChanges.map((change, idx) => {
            const hasWrite = change.edits.some(e => e.tool_name === 'Write');
            const editCount = change.edits.length;
            const isSelected = selectedFile === change;

            return (
              <div
                key={idx}
                className={cn(
                  "flex items-center gap-3 p-3 mb-2 rounded-md cursor-pointer transition-all duration-200 bg-background border border-border",
                  "hover:bg-primary-50 hover:border-primary",
                  isSelected && "bg-primary-100 border-primary shadow-sm"
                )}
                onClick={() => onFileSelect(change)}
              >
                <div className="text-2xl flex-shrink-0">{hasWrite ? '📄' : '✏️'}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-foreground text-sm whitespace-nowrap overflow-hidden text-ellipsis">
                      {change.file_path.split('/').pop()}
                    </span>
                    {editCount > 1 && (
                      <Badge variant="default" className="text-[0.7rem] px-1.5 py-0.5 rounded-full">
                        {editCount}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis font-mono">
                    {change.file_path}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
