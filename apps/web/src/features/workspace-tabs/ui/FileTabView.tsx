/**
 * FileTabView — dedicated single-file viewer tab in the right-side pane.
 *
 * Wraps FileViewer with CloudSandboxGate awareness for sleeping/provisioning
 * cloud workspaces, plus a 1-click jump to reveal the file in the Files tree.
 */

import { isBrowserPreviewPath } from "@/features/session/lib/chatResources";
import { chatPlaceNow, openFromChat } from "@/features/session/lib/openFromChat";
import { localFolder, openFile } from "@/features/workspace/lib/reach";
import { FileViewer } from "@/features/file-browser";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { CloudSandboxGate } from "@/features/workspace/ui/CloudSandboxGate";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import type { Workspace } from "@/shared/types";

interface FileTabViewProps {
  workspace: Workspace;
  filePath: string;
}

export function FileTabView({ workspace, filePath }: FileTabViewProps) {
  const gateStage = cloudGateStage(workspace);
  if (gateStage) {
    return <CloudSandboxGate workspaceId={workspace.id} stage={gateStage} />;
  }

  return (
    <FileViewer
      workspaceId={workspace.id}
      filePath={filePath.replace(/^\/+/, "")}
      onPreviewBinary={
        workspace.kind !== "cloud" && isBrowserPreviewPath(filePath)
          ? () => {
              const place = chatPlaceNow(workspace.id, {
                cloud: false,
                folder: localFolder(workspace),
              });
              void openFromChat(workspace.id, openFile(filePath, place, "preview"));
            }
          : undefined
      }
      onRevealInFiles={() => workspaceLayoutActions.revealFileInTree(workspace.id, filePath)}
    />
  );
}
