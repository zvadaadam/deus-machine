import { FileViewerSheet } from "@/features/file-browser/ui/FileViewerSheet";
import { useCurrentFileVisit } from "@/features/workspace/lib/fileVisit";
import { appHistory } from "@/shared/lib/appHistory";
import type { Workspace } from "@/shared/types";

export function WorkspaceFileSheet({ workspace }: { workspace: Workspace }) {
  const visit = useCurrentFileVisit();
  const file =
    visit?.workspaceId === workspace.id
      ? { ...visit, name: workspace.title ?? workspace.slug }
      : undefined;
  return <FileViewerSheet file={file} close={() => appHistory().back()} />;
}
