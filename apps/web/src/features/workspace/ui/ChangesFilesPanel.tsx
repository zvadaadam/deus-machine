/**
 * ChangesFilesPanel — Compact file panel showing only changed files.
 *
 * Renders inside the Code panel's "Changes" view (pinned mode + minimap hover).
 * Files are grouped by directory with collapsible folder headers.
 * Color dots indicate change status: green=added, yellow=modified, red=deleted.
 */

import { useState, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { getChangeStatus, STATUS_BG, fileChangePath } from "../lib/workspace.utils";
import type { FileChange } from "@/shared/types";

interface ChangesFilesPanelProps {
  fileChanges: FileChange[];
  selectedFile: string | null;
  onFileClick: (path: string) => void;
}

interface FileEntry {
  path: string;
  name: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

interface FolderGroup {
  folder: string;
  files: FileEntry[];
}

/** Group flat file changes into folder groups */
function groupByFolder(fileChanges: FileChange[]): FolderGroup[] {
  const folderMap = new Map<string, FileEntry[]>();

  for (const change of fileChanges) {
    const path = fileChangePath(change);
    if (!path) continue;

    const lastSlash = path.lastIndexOf("/");
    const folder = lastSlash > 0 ? path.substring(0, lastSlash) : "";
    const name = lastSlash > 0 ? path.substring(lastSlash + 1) : path;

    const files = folderMap.get(folder) ?? [];
    files.push({
      path,
      name,
      status: getChangeStatus(change),
      additions: change.additions,
      deletions: change.deletions,
    });
    folderMap.set(folder, files);
  }

  // Sort folders alphabetically, root files ("") last
  const groups: FolderGroup[] = [];
  const sortedFolders = [...folderMap.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  for (const folder of sortedFolders) {
    const files = folderMap.get(folder)!;
    files.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ folder, files });
  }

  return groups;
}

export function ChangesFilesPanel({
  fileChanges,
  selectedFile,
  onFileClick,
}: ChangesFilesPanelProps) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupByFolder(fileChanges), [fileChanges]);

  const toggleFolder = useCallback((folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* File list — no header, keeps it clean */}
      <div className="flex-1 overflow-y-auto py-1">
        {groups.map((group) => (
          <FolderGroupView
            key={group.folder || "__root__"}
            group={group}
            collapsed={collapsedFolders.has(group.folder)}
            onToggle={toggleFolder}
            selectedFile={selectedFile}
            onFileClick={onFileClick}
          />
        ))}
      </div>
    </div>
  );
}

function FolderGroupView({
  group,
  collapsed,
  onToggle,
  selectedFile,
  onFileClick,
}: {
  group: FolderGroup;
  collapsed: boolean;
  onToggle: (folder: string) => void;
  selectedFile: string | null;
  onFileClick: (path: string) => void;
}) {
  const isRoot = group.folder === "";

  return (
    <div>
      {/* Folder header — skip for root-level files */}
      {!isRoot && (
        <button
          type="button"
          onClick={() => onToggle(group.folder)}
          className="text-text-muted hover:text-text-secondary ease flex h-6 w-full items-center gap-1.5 px-3 text-left transition-colors duration-150"
        >
          {collapsed ? (
            <ChevronRight className="text-text-muted/60 h-3 w-3 flex-shrink-0" />
          ) : (
            <ChevronDown className="text-text-muted/60 h-3 w-3 flex-shrink-0" />
          )}
          <Folder className="text-text-muted/60 h-3 w-3 flex-shrink-0" />
          <span className="min-w-0 truncate text-xs">{group.folder}</span>
        </button>
      )}

      {/* Files — hidden when folder is collapsed */}
      {!collapsed &&
        group.files.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onFileClick(file.path)}
            className={cn(
              "ease flex h-6 w-full items-center gap-1.5 text-left transition-colors duration-150",
              isRoot ? "px-3" : "pr-3 pl-8",
              selectedFile === file.path
                ? "bg-bg-elevated text-text-secondary"
                : "text-text-muted hover:text-text-secondary"
            )}
          >
            <span
              className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", STATUS_BG[file.status])}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                file.status === "deleted" && "line-through opacity-50"
              )}
            >
              {file.name}
            </span>
            {(file.additions > 0 || file.deletions > 0) && (
              <span className="flex flex-shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums opacity-50">
                {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
                {file.deletions > 0 && <span className="text-destructive">-{file.deletions}</span>}
              </span>
            )}
          </button>
        ))}
    </div>
  );
}
