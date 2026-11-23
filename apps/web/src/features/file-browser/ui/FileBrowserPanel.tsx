import { FileCode, FolderOpen, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useFiles } from "../api/useFiles";
import { Button } from "@/components/ui/button";
import { FileTree } from "./components/FileTree";
import { cn } from "@/shared/lib/utils";
import type { Workspace, FileChange } from "@/shared/types";
import type { FileTreeNode } from "../types";
import type { PendingFileNavigation } from "@/features/workspace/store/workspaceLayoutStore";

const EMPTY_FILE_CHANGES: FileChange[] = [];

interface FileBrowserPanelProps {
  selectedWorkspace: Workspace | null;
  /** Git diff file changes — overlaid onto the tree as +N/-N indicators */
  fileChanges?: FileChange[];
  /** Controlled selection path */
  selectedFilePath?: string | null;
  /** Called when any file is clicked */
  onFileClick?: (path: string) => void;
  /** Optional one-shot request to reveal a file in the tree */
  revealRequest?: PendingFileNavigation | null;
  /** Called after a reveal request has been applied to the tree */
  onRevealConsumed?: (requestId: string) => void;
  /** Action at the end of the search field. */
  toolbarAction?: ReactNode;
}

/** Join the scanned tree to the diff by the file's current path. */
function enrichTreeWithChanges(nodes: FileTreeNode[], changes: FileChange[]): FileTreeNode[] {
  if (changes.length === 0) return nodes;

  const changeMap = new Map(changes.map((change) => [change.file, change]));

  function walk(nodeList: FileTreeNode[]): FileTreeNode[] {
    return nodeList.map((node) => {
      if (node.children) return { ...node, children: walk(node.children) };
      const change = changeMap.get(node.path);
      if (!change || node.type !== "file") return node;
      return {
        ...node,
        additions: change.additions,
        deletions: change.deletions,
        change_status: change.status,
        previous_path: change.previous_path,
      };
    });
  }

  return walk(nodes);
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

export function FileBrowserPanel({
  selectedWorkspace,
  fileChanges = EMPTY_FILE_CHANGES,
  selectedFilePath,
  onFileClick,
  revealRequest,
  onRevealConsumed,
  toolbarAction,
}: FileBrowserPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const workspaceId = selectedWorkspace?.id ?? null;
  // Cloud trees ride the same route now — the backend branches on kind and
  // serves the sandbox tree over the fs channel.
  const { data, isLoading, isFetching, error, refetch } = useFiles(workspaceId);

  useEffect(() => {
    if (!revealRequest?.requestId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reveal requests intentionally clear stale search filters
    setSearchQuery("");
  }, [revealRequest?.requestId]);

  const enrichedTree = useMemo(
    () => enrichTreeWithChanges(data?.files ?? [], fileChanges),
    [data, fileChanges]
  );
  const filteredFiles = useMemo(
    () => (searchQuery ? filterTreeBySearch(enrichedTree, searchQuery) : enrichedTree),
    [enrichedTree, searchQuery]
  );

  const status = !selectedWorkspace ? (
    <div className="animate-fade-in-up flex flex-1 flex-col items-center justify-center gap-3">
      <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        <FileCode className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-muted-foreground/60 text-xs">Select a workspace to view files</p>
    </div>
  ) : isLoading ? (
    <div className="animate-fade-in flex flex-1 flex-col items-center justify-center gap-3">
      <Loader2 className="text-muted-foreground/50 h-5 w-5 animate-spin" />
      <p className="text-muted-foreground/60 text-xs">Scanning files...</p>
    </div>
  ) : error ? (
    <div className="animate-fade-in-up flex flex-1 flex-col items-center justify-center gap-3">
      <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        <FolderOpen className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
      </div>
      <p role="alert" className="text-muted-foreground/60 max-w-sm px-4 text-center text-xs">
        {error instanceof Error ? error.message : "Unable to load files"}
      </p>
      <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
        <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
        {isFetching ? "Trying again…" : "Try again"}
      </Button>
    </div>
  ) : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-border/30 flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
        <Search className="text-muted-foreground/40 h-3 w-3 flex-shrink-0" />
        <input
          autoFocus
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
        {toolbarAction}
      </div>

      {status ?? (
        <div className="flex-1 overflow-hidden py-1">
          {filteredFiles.length > 0 ? (
            <FileTree
              nodes={filteredFiles}
              selectedPath={selectedFilePath}
              onFileClick={onFileClick}
              revealPath={revealRequest?.path ?? null}
              revealRequestId={revealRequest?.requestId ?? null}
              onRevealConsumed={onRevealConsumed}
            />
          ) : (
            <div className="animate-fade-in-up flex flex-col items-center justify-center gap-3 py-12">
              <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
                <FolderOpen className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
              </div>
              <p className="text-muted-foreground/60 text-xs">
                {searchQuery ? "No matching files" : "No files found"}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
