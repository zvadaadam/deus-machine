import { FileViewerSheet } from "@/features/file-browser/ui/FileViewerSheet";
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
    <FileViewerSheet
      open={!!file}
      close={close}
      workspaceId={workspace.id}
      name={workspace.title ?? workspace.slug}
      path={path}
    />
  );
}
