import type { WorkspaceResource } from "@/features/session/lib/openWorkspaceResource";
import { resolveWorkspaceFileLink } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";
import { useFileContent } from "../api/useFileContent";
import { FilePreview } from "./FilePreview";

interface FileViewerProps {
  workspaceId: string;
  /** Relative path within the workspace. */
  filePath: string;
  onClose?: () => void;
  /** Embedded viewers let their host reveal linked resources. */
  onOpenResource?: (resource: WorkspaceResource) => void;
}

/** Fetch the working-tree file; FilePreview owns the shared presentation. */
export function FileViewer({ workspaceId, filePath, onClose, onOpenResource }: FileViewerProps) {
  const { data, isLoading, error } = useFileContent(workspaceId, filePath);
  return (
    <FilePreview
      filePath={filePath}
      content={data}
      isLoading={isLoading}
      error={error}
      onClose={onClose}
      markdownLinks={
        onOpenResource
          ? {
              resolveFileLink: (href) => {
                if (/^(?:https?:|mailto:|tel:|\/\/|www\.)/iu.test(href)) return null;
                const path = resolveWorkspaceFileLink(href, filePath);
                return { path: path ?? href, disabled: !path };
              },
              onFileLinkOpen: (path) => onOpenResource({ kind: "file", path, target: "files" }),
              onLinkOpen: (href) =>
                onOpenResource({
                  kind: "url",
                  url: href.startsWith("//")
                    ? `https:${href}`
                    : href.startsWith("www.")
                      ? `https://${href}`
                      : href,
                }),
            }
          : undefined
      }
    />
  );
}
