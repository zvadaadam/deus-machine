import type { BoardDetail } from "@shared/boards";
import { FileViewerSheet } from "@/features/file-browser/ui/FileViewerSheet";
import { chatPlaceNow, openFromChat } from "@/features/session/lib/openFromChat";
import { useUnarchiveWorkspace } from "@/features/workspace/api/workspace.queries";
import { useCurrentFileVisit } from "@/features/workspace/lib/fileVisit";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";
import { openFile } from "@/features/workspace/lib/reach";
import { appHistory } from "@/shared/lib/appHistory";

export function BoardFileViewer({ board }: { board: BoardDetail }) {
  const visit = useCurrentFileVisit();
  const restore = useUnarchiveWorkspace();
  const workspace =
    visit &&
    (visit.workspaceId === board.workspace_id
      ? { name: board.coordinator_name, archived: !!board.read_only }
      : board.workspaces[visit.workspaceId]);
  const file = visit &&
    workspace && {
      ...visit,
      ...workspace,
      restoring: restore.isPending,
      onWorkspaceAction: () => {
        const { workspaceId, path } = visit;
        if (workspace.archived) return restore.mutate(workspaceId);
        showWorkspace(workspaceId);
        void openFromChat(
          workspaceId,
          openFile(path, chatPlaceNow(workspaceId, { cloud: false, folder: null }), "files")
        );
      },
    };
  return <FileViewerSheet file={file} close={() => appHistory().back()} />;
}
