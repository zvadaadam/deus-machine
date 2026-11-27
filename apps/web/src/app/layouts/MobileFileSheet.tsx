import { FileViewerSheet } from "@/features/file-browser/ui/FileViewerSheet";
import { useWorkspaceTabsState } from "@/features/workspace/hooks/useWorkspaceLayout";
import {
  useWorkspaceLayoutStore,
  workspaceLayoutActions,
} from "@/features/workspace/store/workspaceLayoutStore";
import { appHistory } from "@/shared/lib/appHistory";
import type { Workspace } from "@/shared/types";

export function MobileFileSheet({ workspace }: { workspace: Workspace }) {
  const { activeTab } = useWorkspaceTabsState(workspace.id);
  const request = useWorkspaceLayoutStore((s) => s.layouts[workspace.id]?.pendingFileNavigation);
  const file =
    activeTab.kind === "file" && request?.target === "files" && request.path === activeTab.path
      ? { workspaceId: workspace.id, name: workspace.title ?? workspace.slug, path: activeTab.path }
      : undefined;

  const close = () => {
    const history = appHistory();
    if (history.location.state.workspaceFile?.workspaceId === workspace.id) history.back();
    else workspaceLayoutActions.setPendingFileNavigation(workspace.id, null);
  };
  return <FileViewerSheet file={file} close={close} />;
}
