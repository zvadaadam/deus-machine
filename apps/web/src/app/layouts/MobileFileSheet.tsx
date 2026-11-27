import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { FileViewer } from "@/features/file-browser/ui/FileViewer";
import { useWorkspaceTabsState } from "@/features/workspace/hooks/useWorkspaceLayout";
import { useWorkspaceLayoutStore } from "@/features/workspace/store";
import { appHistory } from "@/shared/lib/appHistory";
import type { Workspace } from "@/shared/types";

export function MobileFileSheet({ workspace }: { workspace: Workspace }) {
  const { activeTab, closeTab } = useWorkspaceTabsState(workspace.id);
  const selected = useWorkspaceLayoutStore((s) => s.layouts[workspace.id]?.selectedFilePath);
  const file = activeTab.kind === "file" ? activeTab : null;
  const path = file?.path ?? selected;
  const close = () => {
    if (!file) return;
    const history = appHistory();
    if (history.location.state.workspaceFile?.workspaceId === workspace.id) history.back();
    else closeTab(file.id);
  };
  return (
    <Sheet
      open={!!file}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        className="w-full gap-0 border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:max-w-none [&>button]:top-[env(safe-area-inset-top)] [&>button]:right-1 [&>button]:size-11"
      >
        <SheetTitle className="border-border-subtle truncate border-b py-2.5 pr-12 pl-4 text-base">
          {workspace.title ?? workspace.slug}
        </SheetTitle>
        {path && (
          <div className="min-h-0 flex-1">
            <FileViewer workspaceId={workspace.id} filePath={path} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
