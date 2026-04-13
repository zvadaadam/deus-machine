/**
 * Unified File Browser Panel
 * Single tree view for all files + change indicators.
 * Replaces the old two-tab (Changes / All files) approach.
 */

import {
  FolderOpen,
  Loader2,
  GitBranch,
  FileCode,
  Check,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ChevronDown,
  X,
} from "lucide-react";
import { useState, useMemo, useRef, useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFiles, invalidateFileCache } from "../api/useFiles";
import { FileTree } from "./components/FileTree";
import { cn } from "@/shared/lib/utils";
import {
  CHANGES_FILTER_OPTIONS,
  changesFilterLabel,
  type ChangesFilter,
} from "@/features/workspace/lib/changesFilter";
import type { Workspace, FileChange } from "@/shared/types";
import type { FileTreeNode } from "../types";
import type { PendingFileNavigation } from "@/features/workspace/store/workspaceLayoutStore";

type FilterMode = "all" | "changes";

const EMPTY_FILE_CHANGES: FileChange[] = [];

interface FileBrowserPanelProps {
  selectedWorkspace: Workspace | null;
  /** Git diff file changes — overlaid onto the tree as +N/-N indicators */
  fileChanges?: FileChange[];
  /** Uncommitted-only file changes (HEAD → workdir) */
  uncommittedFiles?: FileChange[];
  /** Last-turn file changes (checkpoint → workdir) */
  lastTurnFiles?: FileChange[];
  /** True if the file changes list was truncated (too many files) */
  fileChangesTruncated?: boolean;
  /** Total number of changed files (before truncation) */
  fileChangesTotalCount?: number;
  /** Controlled selection path */
  selectedFilePath?: string | null;
  /** Called when any file is clicked */
  onFileClick?: (path: string) => void;
  /** Optional one-shot request to reveal a file in the tree */
  revealRequest?: PendingFileNavigation | null;
  /** Called after a reveal request has been applied to the tree */
  onRevealConsumed?: (requestId: string) => void;
  /** Optional header slot rendered above the panel */
  headerSlot?: React.ReactNode;
  /** Controlled filter mode — when provided, component uses this instead of local state */
  filterMode?: FilterMode;
  /** Called when user changes the filter tab (Changes / All files) */
  onFilterModeChange?: (mode: FilterMode) => void;
  /** Hide the internal tab toggle (when parent handles tab switching) */
  hideTabToggle?: boolean;
}

/**
 * Overlay change data (additions/deletions) from git diff onto the IPC-scanned tree.
 * Builds a path→change lookup and walks the tree to decorate matching files.
 */
function enrichTreeWithChanges(nodes: FileTreeNode[], changes: FileChange[]): FileTreeNode[] {
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

/** Filter tree to only files with actual diff changes (and their ancestor directories).
 *
 * Uses `change_status` (set by enrichTreeWithChanges from diff query results) only.
 * Does NOT use `git_status` (from the file scanner) because libgit2's status API
 * produces phantom statuses in git worktrees, causing clean files to appear as changed.
 */
function filterToChangedOnly(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.reduce((acc, node) => {
    if (node.type === "file") {
      if (node.change_status) {
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
function filterToChangeSet(nodes: FileTreeNode[], allowedPaths: Set<string>): FileTreeNode[] {
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
  fileChanges = EMPTY_FILE_CHANGES,
  uncommittedFiles,
  lastTurnFiles,
  fileChangesTruncated,
  fileChangesTotalCount,
  selectedFilePath,
  onFileClick: onFileClickProp,
  revealRequest,
  onRevealConsumed,
  headerSlot,
  filterMode: controlledFilterMode,
  onFilterModeChange,
  hideTabToggle = false,
}: FileBrowserPanelProps) {
  // Controlled when parent provides filterMode, uncontrolled fallback otherwise.
  const [localFilterMode, setLocalFilterMode] = useState<FilterMode>("changes");
  const filterMode = controlledFilterMode ?? localFilterMode;
  const setFilterMode = onFilterModeChange ?? setLocalFilterMode;
  const [changesFilter, setChangesFilter] = useState<ChangesFilter>("all-changes");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const workspaceId = selectedWorkspace?.id ?? null;
  const { data, isLoading, error, refetch } = useFiles(workspaceId);

  const handleFileClick = (path: string) => {
    onFileClickProp?.(path);
  };

  const handleRefresh = async () => {
    if (workspaceId) {
      await invalidateFileCache(workspaceId);
      refetch();
    }
  };

  // Focus search input when it appears
  useEffect(() => {
    if (filterMode === "all" && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [filterMode]);

  useEffect(() => {
    if (!revealRequest?.requestId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reveal requests intentionally clear stale search filters
    setSearchQuery("");
  }, [revealRequest?.requestId]);

  // Clear search when switching away from All tab
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clear search on filter change
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
        <div className="animate-fade-in-up flex flex-1 flex-col items-center justify-center gap-3">
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
        <div className="animate-fade-in flex flex-1 flex-col items-center justify-center gap-3">
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
        <div className="animate-fade-in-up flex flex-1 flex-col items-center justify-center gap-3">
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

      {/* Header: tab toggle (left) + filter dropdown (right) — hidden when parent manages tabs */}
      {!hideTabToggle && (
        <div className="flex h-9 flex-shrink-0 items-center justify-between px-3">
          {/* Tab toggle: Changes | All files */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setFilterMode("changes")}
              className={cn(
                "rounded-lg px-2 py-1 text-xs transition-colors duration-200 ease-[ease]",
                filterMode === "changes"
                  ? "bg-muted text-secondary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Changes
            </button>
            <button
              onClick={() => setFilterMode("all")}
              className={cn(
                "rounded-lg px-2 py-1 text-xs transition-colors duration-200 ease-[ease]",
                filterMode === "all"
                  ? "bg-muted text-secondary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              All files
            </button>
          </div>

          {/* Right-side actions — visible in Changes mode */}
          {filterMode === "changes" && (
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-lg py-1 text-xs transition-colors duration-200 ease-[ease]">
                    <SlidersHorizontal className="h-[11px] w-[11px]" />
                    <span>{changesFilterLabel(changesFilter)}</span>
                    <ChevronDown className="h-[10px] w-[10px]" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[140px]">
                  {CHANGES_FILTER_OPTIONS.map(([value, label]) => (
                    <DropdownMenuItem
                      key={value}
                      onClick={() => setChangesFilter(value)}
                      className="gap-2 text-xs"
                    >
                      <Check
                        className={cn(
                          "h-3 w-3",
                          changesFilter === value ? "opacity-100" : "opacity-0"
                        )}
                      />
                      {label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleRefresh} className="gap-2 text-xs">
                    <RefreshCw className="h-3 w-3" />
                    Refresh files
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      )}

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
            className="text-foreground placeholder:text-muted-foreground/40 h-5 min-w-0 flex-1 bg-transparent text-xs outline-none"
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

      {/* Truncation warning — shown when diff has too many files */}
      {fileChangesTruncated && filterMode === "changes" && (
        <div className="border-border/30 bg-muted/20 border-b px-2.5 py-1.5">
          <p className="text-muted-foreground text-xs">
            Showing {fileChanges.length.toLocaleString()} of{" "}
            {(fileChangesTotalCount ?? 0).toLocaleString()} changed files
          </p>
        </div>
      )}

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {filteredFiles.length > 0 ? (
          <FileTree
            nodes={filteredFiles}
            selectedPath={selectedFilePath}
            onFileClick={handleFileClick}
            defaultExpanded={filterMode === "changes"}
            revealPath={revealRequest?.path ?? null}
            revealRequestId={revealRequest?.requestId ?? null}
            onRevealConsumed={onRevealConsumed}
          />
        ) : (
          <div className="animate-fade-in-up flex flex-col items-center justify-center gap-3 py-12">
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
