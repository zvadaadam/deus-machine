/**
 * Code Panel Content — Changes/Files tab header + content switching.
 * Deduplicates the shared tab header that was previously copy-pasted in MainContent.
 */

import { Tabs, TabsContent } from "@/components/ui";
import { FileChangesPanel } from "@/features/file-changes";
import { FileBrowserPanel } from "@/features/file-browser";
import { cn } from "@/shared/lib/utils";
import NumberFlow from "@number-flow/react";
import type { Workspace } from "@/shared/types";
import type { FileChange } from "@/features/workspace/types";
import type { RightPanelTab } from "@/features/workspace/store";

interface CodePanelContentProps {
  workspace: Workspace;
  fileChanges: FileChange[];
  rightPanelTab: RightPanelTab;
  selectedFilePath?: string | null;
  onTabChange: (tab: RightPanelTab) => void;
  onFileSelect: (path: string | null) => void;
  onBrowserFileClick: (path: string) => void;
}

export function CodePanelContent({
  workspace,
  fileChanges,
  rightPanelTab,
  selectedFilePath,
  onTabChange,
  onFileSelect,
  onBrowserFileClick,
}: CodePanelContentProps) {
  const tabHeader = (
    <div className="border-border/40 flex h-9 flex-shrink-0 items-center gap-1 border-b px-2">
      <button
        onClick={() => onTabChange("changes")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[ease]",
          rightPanelTab === "changes"
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground/60 hover:text-muted-foreground"
        )}
      >
        Changes
        {fileChanges.length > 0 && (
          <span className="bg-muted-foreground/20 text-muted-foreground rounded px-1.5 py-0.5 text-[10px] leading-none font-medium">
            <NumberFlow value={fileChanges.length} />
          </span>
        )}
      </button>
      <button
        onClick={() => onTabChange("files")}
        className={cn(
          "inline-flex items-center rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[ease]",
          rightPanelTab === "files"
            ? "bg-accent text-foreground font-medium"
            : "text-muted-foreground/60 hover:text-muted-foreground"
        )}
      >
        All files
      </button>
    </div>
  );

  return (
    <Tabs
      value={rightPanelTab}
      onValueChange={(v) => onTabChange(v as RightPanelTab)}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <TabsContent
        value="changes"
        className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
      >
        <FileChangesPanel
          selectedWorkspace={workspace}
          fileChanges={fileChanges}
          selectedFilePath={selectedFilePath}
          onFileSelect={onFileSelect}
          headerSlot={tabHeader}
        />
      </TabsContent>

      <TabsContent
        value="files"
        className="m-0 h-full overflow-hidden data-[state=inactive]:hidden"
      >
        <div className="flex h-full flex-col overflow-hidden">
          {tabHeader}
          <div className="flex-1 overflow-hidden">
            <FileBrowserPanel selectedWorkspace={workspace} onFileClick={onBrowserFileClick} />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}
