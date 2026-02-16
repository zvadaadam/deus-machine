/**
 * Unified File Browser Panel
 * Single tree view for all files + change indicators.
 * Replaces the old two-tab (Changes / All files) approach.
 */

import { FolderOpen, Loader2, GitBranch, FileCode, MoreHorizontal, RefreshCw, Search, X } from "lucide-react";
import { useState, useMemo, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFilesRust, invalidateFileCache } from "../api/useFilesRust";
import { FileTree } from "./components/FileTree";
import { cn } from "@/shared/lib/utils";
import type { Workspace, FileChange } from "@/shared/types";
import type { FileTreeNode } from "../types";

type FilterMode = "all" | "changes";
type ChangesFilter = "all-changes" | "uncommitted" | "last-turn";

interface FileBrowserPanelProps {
  selectedWorkspace: Workspace | null;
  /** Git diff file changes — overlaid onto the tree as +N/-N indicators */
  fileChanges?: FileChange[];
  /** Uncommitted-only file changes (HEAD → workdir) */
  uncommittedFiles?: FileChange[];
  /** Last-turn file changes (checkpoint → workdir) */
  lastTurnFiles?: FileChange[];
  /** Controlled selection path */
  selectedFilePath?: string | null;
  /** Called when any file is clicked */
  onFileClick?: (path: string) => void;
  /** Optional header slot rendered above the panel */
  headerSlot?: React.ReactNode;
}

/**
 * Overlay change data (additions/deletions) from git diff onto the Rust-scanned tree.
 * Builds a path→change lookup and walks the tree to decorate matching files.
 */
function enrichTreeWithChanges(
  nodes: FileTreeNode[],
  changes: FileChange[]
): FileTreeNode[] {
  if (changes.length === 0) return nodes;

  const changeMap = new Map<string, FileChange>();
  for (const c of changes) {
    const path = c.file || c.file_path || "";
    if (path) changeMap.set(path, c);
  }

  function walk(nodeList: FileTreeNode[]): FileTreeNode[] {
    return nodeList.map((node) => {
      if (node.type === "file") {
        const change = changeMap.get(node.path);
        if (change) {
          const status =
            change.additions > 0 && change.deletions === 0
              ? "added"
              : change.deletions > 0 && change.additions === 0
                ? "deleted"
                : "modified";
          return {
            ...node,
            additions: change.additions,
            deletions: change.deletions,
            change_status: status as "added" | "modified" | "deleted",
            committed: change.committed,
          };
        }
        return node;
      }
      // Directory: recurse into children
      if (node.children) {
        return { ...node, children: walk(node.children) };
      }
      return node;
    });
  }

  return walk(nodes);
}

/** Filter tree to only files with changes (and their ancestor directories) */
function filterToChangedOnly(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.reduce((acc, node) => {
    if (node.type === "file") {
      if (node.change_status || node.git_status) {
        acc.push(node);
      }
    } else if (node.children) {
      const filtered = filterToChangedOnly(node.children);
      if (filtered.length > 0) {
        acc.push({ ...node, children: filtered });
      }
    }
    return acc;
  }, [] as FileTreeNode[]);
}

/** Filter tree to only files matching a specific change set */
function filterToChangeSet(
  nodes: FileTreeNode[],
  allowedPaths: Set<string>
): FileTreeNode[] {
  return nodes.reduce((acc, node) => {
    if (node.type === "file") {
      if (allowedPaths.has(node.path)) {
        acc.push(node);
      }
    } else if (node.children) {
      const filtered = filterToChangeSet(node.children, allowedPaths);
      if (filtered.length > 0) {
        acc.push({ ...node, children: filtered });
      }
    }
    return acc;
  }, [] as FileTreeNode[]);
}

/** Filter tree by search query (case-insensitive name match, preserving ancestor dirs) */
function filterTreeBySearch(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const lower = query.toLowerCase();
  return nodes.reduce((acc, node) => {
    if (node.type === "file") {
      if (node.name.toLowerCase().includes(lower) || node.path.toLowerCase().includes(lower)) {
        acc.push(node);
      }
    } else if (node.children) {
      // Check if directory name matches — if so, include all children
      if (node.name.toLowerCase().includes(lower)) {
        acc.push(node);
      } else {
        const filtered = filterTreeBySearch(node.children, query);
        if (filtered.length > 0) {
          acc.push({ ...node, children: filtered });
        }
      }
    }
    return acc;
  }, [] as FileTreeNode[]);
}

/** Count changed files in tree */
function countChangedFiles(nodes: FileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "file" && (node.change_status || node.git_status)) count++;
    if (node.children) count += countChangedFiles(node.children);
  }
  return count;
}

/** Build a Set of file paths from a FileChange array */
function buildPathSet(changes: FileChange[]): Set<string> {
  const set = new Set<string>();
  for (const c of changes) {
    const p = c.file || c.file_path || "";
    if (p) set.add(p);
  }
  return set;
}

export function FileBrowserPanel({
  selectedWorkspace,
  fileChanges = [],
  uncommittedFiles,
  lastTurnFiles,
  selectedFilePath,
  onFileClick: onFileClickProp,
  headerSlot,
}: FileBrowserPanelProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>("changes");
  const [changesFilter, setChangesFilter] = useState<ChangesFilter>("all-changes");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const workspacePath = selectedWorkspace?.workspace_path ?? null;
  const { data, isLoading, error, refetch } = useFilesRust(workspacePath);

  const handleFileClick = (path: string) => {
    onFileClickProp?.(path);
  };

  const handleRefresh = async () => {
    if (workspacePath) {
      await invalidateFileCache(workspacePath);
      refetch();
    }
  };

  // Focus search input when it appears
  useEffect(() => {
    if (filterMode === "all" && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [filterMode]);

  // Clear search when switching away from All tab
  useEffect(() => {
    if (filterMode !== "all") setSearchQuery("");
  }, [filterMode]);

  // Path sets for sub-filters
  const uncommittedPaths = useMemo(
    () => (uncommittedFiles ? buildPathSet(uncommittedFiles) : null),
    [uncommittedFiles]
  );
  const lastTurnPaths = useMemo(
    () => (lastTurnFiles ? buildPathSet(lastTurnFiles) : null),
    [lastTurnFiles]
  );

  // Enrich tree with change data + committed flag
  const enrichedTree = useMemo(() => {
    if (!data) return [];

    // Tag committed status: files NOT in uncommitted set are committed
    const taggedChanges = fileChanges.map((c) => {
      const path = c.file || c.file_path || "";
      const isUncommitted = uncommittedPaths ? uncommittedPaths.has(path) : undefined;
      return {
        ...c,
        committed: isUncommitted !== undefined ? !isUncommitted : undefined,
      };
    });

    return enrichTreeWithChanges(data.files, taggedChanges);
  }, [data, fileChanges, uncommittedPaths]);

  const changedCount = useMemo(() => countChangedFiles(enrichedTree), [enrichedTree]);

  // Apply filter mode + sub-filter + search
  const filteredFiles = useMemo(() => {
    if (filterMode === "all") {
      // All files with optional search
      return searchQuery ? filterTreeBySearch(enrichedTree, searchQuery) : enrichedTree;
    }

    // Changes mode — apply sub-filter
    const changedOnly = filterToChangedOnly(enrichedTree);

    if (changesFilter === "uncommitted" && uncommittedPaths) {
      return filterToChangeSet(changedOnly, uncommittedPaths);
    }
    if (changesFilter === "last-turn" && lastTurnPaths) {
      return filterToChangeSet(changedOnly, lastTurnPaths);
    }

    return changedOnly;
  }, [enrichedTree, filterMode, searchQuery, changesFilter, uncommittedPaths, lastTurnPaths]);

  // Empty state — no workspace
  if (!selectedWorkspace) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 animate-fade-in-up">
          <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <FileCode className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground/60 text-xs">Select a workspace to view files</p>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 animate-fade-in">
          <Loader2 className="text-muted-foreground/50 h-5 w-5 animate-spin" />
          <p className="text-muted-foreground/60 text-xs">Scanning files...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 animate-fade-in-up">
          <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <FolderOpen className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground/60 text-xs">
            {error instanceof Error ? error.message : "Unable to load files"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {headerSlot}

      {/* Header: filter toggle (left) + three-dot menu (right) */}
      <div className="border-border/30 flex flex-shrink-0 items-center justify-between border-b px-2 py-1">
        {/* Filter toggle: Changes first, All second */}
        <div className="bg-muted/30 flex items-center rounded-md p-0.5">
          <button
            onClick={() => setFilterMode("changes")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors duration-200 ease-[ease]",
              filterMode === "changes"
                ? "bg-background text-foreground shadow-sm font-medium"
                : "text-muted-foreground/60 hover:text-muted-foreground"
            )}
          >
            <GitBranch className="h-3 w-3" />
            Changes
            {changedCount > 0 && (
              <span className="bg-muted-foreground/20 text-muted-foreground rounded px-1 text-[10px] leading-none font-medium">
                {changedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setFilterMode("all")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] transition-colors duration-200 ease-[ease]",
              filterMode === "all"
                ? "bg-background text-foreground shadow-sm font-medium"
                : "text-muted-foreground/60 hover:text-muted-foreground"
            )}
          >
            All
          </button>
        </div>

        {/* Three-dot menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 flex-shrink-0">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {/* Sub-filter radio group — only visible in Changes mode */}
            {filterMode === "changes" && (
              <>
                <DropdownMenuRadioGroup
                  value={changesFilter}
                  onValueChange={(v) => setChangesFilter(v as ChangesFilter)}
                >
                  <DropdownMenuRadioItem value="all-changes" className="text-xs">
                    All changes
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="uncommitted" className="text-xs">
                    Uncommitted
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="last-turn" className="text-xs">
                    Last turn
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={handleRefresh}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Refresh files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Search bar — only for All files tab */}
      {filterMode === "all" && (
        <div className="border-border/30 flex items-center gap-1.5 border-b px-2 py-1">
          <Search className="text-muted-foreground/40 h-3 w-3 flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Filter files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="text-foreground placeholder:text-muted-foreground/40 h-5 min-w-0 flex-1 bg-transparent text-[11px] outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-muted-foreground/40 hover:text-muted-foreground flex-shrink-0"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* File Tree */}
      <div className="scrollbar-vibrancy flex-1 overflow-y-auto py-1">
        {filteredFiles.length > 0 ? (
          <FileTree
            key={filterMode}
            nodes={filteredFiles}
            selectedPath={selectedFilePath}
            onFileClick={handleFileClick}
            defaultExpanded={filterMode === "changes"}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-12 animate-fade-in-up">
            <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
              {filterMode === "changes" ? (
                <GitBranch className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
              ) : (
                <FolderOpen className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <p className="text-muted-foreground/60 text-xs">
              {filterMode === "changes"
                ? "No file changes detected"
                : searchQuery
                  ? "No matching files"
                  : "No files found"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
