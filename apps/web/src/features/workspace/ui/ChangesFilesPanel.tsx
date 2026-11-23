/**
 * ChangesFilesPanel — Compact file panel showing only changed files.
 *
 * Renders inside the Code panel's "Changes" view (pinned mode + minimap hover).
 * Files are grouped by directory with collapsible folder headers.
 */

import { useState, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { fileChangeLabel, STATUS_BG } from "../lib/workspace.utils";
import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";
import type { FileChange } from "@/shared/types";

interface ChangesFilesPanelProps {
  fileChanges: FileChange[];
  selectedFile: string | null;
  onFileClick: (path: string) => void;
}

interface FolderGroup {
  folder: string;
  files: FileChange[];
}

/** Group flat file changes into folder groups */
function groupByFolder(fileChanges: FileChange[]): FolderGroup[] {
  const folderMap = new Map<string, FileChange[]>();

  for (const change of fileChanges) {
    const folder = change.file.substring(0, change.file.lastIndexOf("/"));
    const files = folderMap.get(folder) ?? [];
    files.push(change);
    folderMap.set(folder, files);
  }

  // Root files follow the folders.
  const groups = Array.from(folderMap, ([folder, files]) => ({
    folder,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
  }));
  return groups.sort(({ folder: a }, { folder: b }) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
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
            key={group.folder}
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
          className="control-interaction text-text-muted hover:text-text-secondary flex h-6 w-full items-center gap-1.5 px-3 text-left"
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
        group.files.map((change) => {
          const name = change.file.slice(change.file.lastIndexOf("/") + 1);
          const label = fileChangeLabel(change);
          return (
            <button
              key={change.file}
              type="button"
              onClick={() => onFileClick(change.file)}
              title={label}
              aria-label={label}
              className={cn(
                "control-interaction flex h-6 w-full items-center gap-1.5 text-left",
                isRoot ? "px-3" : "pr-3 pl-8",
                selectedFile === change.file
                  ? "bg-bg-elevated text-text-secondary"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", STATUS_BG[change.status])}
              />
              <PierreFileIcon
                fileName={name}
                size={13}
                className="text-text-muted/70 flex-shrink-0"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  change.status === "deleted" && "line-through opacity-50"
                )}
              >
                {name}
              </span>
              {(change.additions > 0 || change.deletions > 0) && (
                <span className="flex flex-shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums opacity-50">
                  {change.additions > 0 && (
                    <span className="text-success">+{change.additions}</span>
                  )}
                  {change.deletions > 0 && (
                    <span className="text-destructive">-{change.deletions}</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
    </div>
  );
}
