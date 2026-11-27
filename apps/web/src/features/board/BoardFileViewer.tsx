import { useState } from "react";
import type { BoardDetail } from "@shared/boards";
import { Button } from "@/components/ui/button";
import { FileViewerSheet } from "@/features/file-browser/ui/FileViewerSheet";
import { chatPlaceNow, openFromChat } from "@/features/session/lib/openFromChat";
import { useUnarchiveWorkspace } from "@/features/workspace/api/workspace.queries";
import { useCurrentFileVisit } from "@/features/workspace/lib/fileVisit";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";
import { openFile } from "@/features/workspace/lib/reach";
import { appHistory } from "@/shared/lib/appHistory";

export function BoardFileViewer({ board }: { board: BoardDetail }) {
  const visit = useCurrentFileVisit();
  // Keep the closing sheet's file through its exit animation.
  const [last, setLast] = useState(visit);
  if (visit && visit !== last) setLast(visit);
  const file = visit ?? last;
  const restore = useUnarchiveWorkspace();
  if (!file) return null;
  const { workspaceId, path } = file;
  const workspace =
    workspaceId === board.workspace_id
      ? { name: board.coordinator_name, archived: !!board.read_only }
      : board.workspaces[workspaceId];
  if (!workspace) return null;
  const open = () => {
    showWorkspace(workspaceId);
    void openFromChat(
      workspaceId,
      openFile(path, chatPlaceNow(workspaceId, { cloud: false, folder: null }), "files")
    );
  };
  return (
    <FileViewerSheet
      open={!!visit}
      close={() => appHistory().back()}
      workspaceId={workspaceId}
      path={path}
      {...workspace}
      action={
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto shrink-0"
          disabled={restore.isPending}
          onClick={workspace.archived ? () => restore.mutate(workspaceId) : open}
        >
          {workspace.archived ? "Restore workspace" : "Open in workspace"}
        </Button>
      }
    />
  );
}
