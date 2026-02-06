/**
 * DiffTabContent — Self-contained diff viewer for chat area tabs.
 *
 * Fetches diff data via useFileDiff (TanStack Query with 10s cache)
 * and renders the existing DiffViewer component. Each tab instance
 * owns its own query, so multiple diff tabs work independently.
 */

import { useMemo } from "react";
import { DiffViewer } from "./DiffViewer";
import { useFileDiff } from "../api/workspace.queries";
import type { WorkspaceGitInfo } from "../api/workspace.service";

interface DiffTabContentProps {
  workspaceId: string;
  filePath: string;
  workspaceGitInfo: WorkspaceGitInfo;
  onClose?: () => void;
}

export function DiffTabContent({
  workspaceId,
  filePath,
  workspaceGitInfo,
  onClose,
}: DiffTabContentProps) {
  const { data, isLoading, error } = useFileDiff(workspaceId, filePath, workspaceGitInfo);

  return (
    <DiffViewer
      filePath={filePath}
      diff={data?.diff ?? ""}
      oldContent={data?.oldContent ?? null}
      newContent={data?.newContent ?? null}
      isLoading={isLoading}
      error={error?.message}
      onClose={onClose}
    />
  );
}
