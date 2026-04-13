/**
 * Files View — file browser + file preview for the Files content tab.
 *
 * Left panel: file viewer (selected file preview).
 * Right panel: file browser tree (full workspace file tree).
 * Fetches its own file change data for marking modified files.
 */

import { useCallback, useMemo } from "react";
import { FileText } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useWorkspaceLayout } from "../hooks/useWorkspaceLayout";
import { useFileChanges } from "../api/workspace.queries";
import { FileBrowserPanel, FileViewer } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import { useWorkspaceLayoutStore, workspaceLayoutActions } from "../store/workspaceLayoutStore";

interface FilesViewProps {
  workspace: Workspace;
  /** Whether file watcher is active — disables polling in useFileChanges */
  isWatched?: boolean;
}

export function FilesView({ workspace, isWatched = false }: FilesViewProps) {
  const { selectedFilePath, setSelectedFilePath } = useWorkspaceLayout(workspace.id);
  const pendingFileNavigation = useWorkspaceLayoutStore(
    (state) => state.layouts[workspace.id]?.pendingFileNavigation ?? null
  );
  const revealRequest = pendingFileNavigation?.target === "files" ? pendingFileNavigation : null;
  const isReady = workspace.state === "ready";

  const { data: fileChangesData } = useFileChanges(
    isReady ? workspace.id : null,
    workspace.session_status,
    isWatched,
    workspace.state
  );
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);

  const handleRevealConsumed = useCallback(
    (requestId: string) => {
      const currentRequest =
        useWorkspaceLayoutStore.getState().layouts[workspace.id]?.pendingFileNavigation;
      if (currentRequest?.requestId !== requestId) return;
      workspaceLayoutActions.setPendingFileNavigation(workspace.id, null);
    },
    [workspace.id]
  );

  return (
    <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={75} minSize={30}>
        {selectedFilePath ? (
          <FileViewer workspaceId={workspace.id} filePath={selectedFilePath.replace(/^\/+/, "")} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
              <FileText className="text-text-muted/50 h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-text-muted/60 text-xs">Select a file to preview</p>
          </div>
        )}
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize={25} minSize={15}>
        <FileBrowserPanel
          key={revealRequest?.requestId ?? "files-browser"}
          selectedWorkspace={workspace}
          fileChanges={fileChanges}
          selectedFilePath={selectedFilePath}
          onFileClick={setSelectedFilePath}
          revealRequest={revealRequest}
          onRevealConsumed={handleRevealConsumed}
          filterMode="all"
          hideTabToggle
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
