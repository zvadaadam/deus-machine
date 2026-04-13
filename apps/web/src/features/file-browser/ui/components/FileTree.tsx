/**
 * Unified File Tree
 * Condensed tree with file type icons, change indicators,
 * selection highlighting, and indent guides.
 */

import { useState, memo, useCallback, useEffect, useRef } from "react";
import {
  ChevronRight,
  ChevronDown,
  File,
  FileText,
  FileCode,
  FileJson,
  FileImage,
  FileType,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { FileTreeNode } from "../../types";

const INDENT_PX = 16;

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedPath?: string | null;
  onFileClick?: (path: string) => void;
  level?: number;
  /** When true, all directories start expanded. When false, all start collapsed. */
  defaultExpanded?: boolean;
  revealPath?: string | null;
  revealRequestId?: string | null;
  onRevealConsumed?: (requestId: string) => void;
}

function pathContainsTarget(nodePath: string, targetPath: string | null | undefined) {
  if (!targetPath) return false;
  return targetPath === nodePath || targetPath.startsWith(`${nodePath}/`);
}

/** File icon + color by extension */
function getFileIconConfig(filename: string): { icon: typeof File; color: string } {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext))
    return { icon: FileCode, color: "text-file-typescript" };
  if (["rs", "toml"].includes(ext)) return { icon: FileCode, color: "text-file-rust" };
  if (["json", "yaml", "yml", "xml"].includes(ext))
    return { icon: FileJson, color: "text-file-data" };
  if (["md", "mdx", "txt", "rst"].includes(ext)) return { icon: FileText, color: "text-file-docs" };
  if (["css", "scss", "sass", "less"].includes(ext))
    return { icon: FileCode, color: "text-file-styles" };
  if (["html", "htm"].includes(ext)) return { icon: FileCode, color: "text-file-markup" };
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext))
    return { icon: FileImage, color: "text-file-image" };
  if (
    ["env", "gitignore", "dockerignore", "editorconfig"].includes(ext) ||
    filename.startsWith(".")
  )
    return { icon: FileType, color: "text-muted-foreground/50" };
  return { icon: File, color: "text-muted-foreground/40" };
}

/** Check if folder contains any changed files recursively */
function hasChanges(node: FileTreeNode): boolean {
  if (node.type === "file") return !!node.git_status || !!node.change_status;
  return node.children?.some((child) => hasChanges(child)) || false;
}

export function FileTree({
  nodes,
  selectedPath,
  onFileClick,
  level = 0,
  defaultExpanded,
  revealPath,
  revealRequestId,
  onRevealConsumed,
}: FileTreeProps) {
  return (
    <div className={cn(level === 0 && "group/tree")} role={level === 0 ? "tree" : "group"}>
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          level={level}
          selectedPath={selectedPath}
          onFileClick={onFileClick}
          defaultExpanded={defaultExpanded}
          revealPath={revealPath}
          revealRequestId={revealRequestId}
          onRevealConsumed={onRevealConsumed}
        />
      ))}
    </div>
  );
}

const TreeNode = memo(function TreeNode({
  node,
  level,
  selectedPath,
  onFileClick,
  defaultExpanded,
  revealPath,
  revealRequestId,
  onRevealConsumed,
}: {
  node: FileTreeNode;
  level: number;
  selectedPath?: string | null;
  onFileClick?: (path: string) => void;
  defaultExpanded?: boolean;
  revealPath?: string | null;
  revealRequestId?: string | null;
  onRevealConsumed?: (requestId: string) => void;
}) {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  const isDirectory = node.type === "directory";
  const hasChildren = node.children && node.children.length > 0;
  const indentPx = level * INDENT_PX;
  const isSelected = selectedPath === node.path;

  const fileConfig = !isDirectory ? getFileIconConfig(node.name) : null;
  const FileIcon = fileConfig?.icon;
  const folderHasChanges = isDirectory && hasChanges(node);
  const shouldRevealNode = pathContainsTarget(node.path, revealPath);
  const isExpanded = manualExpanded ?? (shouldRevealNode || (defaultExpanded ?? false));

  const handleClick = useCallback(() => {
    if (isDirectory) {
      setManualExpanded(!isExpanded);
    } else {
      onFileClick?.(node.path);
    }
  }, [isDirectory, isExpanded, node.path, onFileClick]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleClick();
      }
      if (isDirectory) {
        if (e.key === "ArrowLeft" && isExpanded) {
          e.preventDefault();
          setManualExpanded(false);
        } else if (e.key === "ArrowRight" && !isExpanded) {
          e.preventDefault();
          setManualExpanded(true);
        }
      }
    },
    [isDirectory, isExpanded, handleClick]
  );

  useEffect(() => {
    if (!isDirectory || !revealRequestId || !shouldRevealNode) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reveal requests intentionally persist expanded ancestors after navigation
    setManualExpanded(true);
  }, [isDirectory, revealRequestId, shouldRevealNode]);

  useEffect(() => {
    if (isDirectory || !revealRequestId || !shouldRevealNode) return;

    const target = itemRef.current;
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    onRevealConsumed?.(revealRequestId);
  }, [isDirectory, onRevealConsumed, revealRequestId, shouldRevealNode]);

  // Indent guide lines (visible on tree hover)
  const indentGuides: React.ReactElement[] = [];
  for (let i = 0; i < level; i++) {
    indentGuides.push(
      <span
        key={i}
        className="bg-border/50 absolute top-0 bottom-0 w-px opacity-0 transition-opacity duration-150 group-hover/tree:opacity-100"
        style={{ left: `${i * INDENT_PX + 12}px` }}
      />
    );
  }

  return (
    <div
      role="treeitem"
      aria-expanded={isDirectory ? isExpanded : undefined}
      className="[contain-intrinsic-size:auto_24px] [content-visibility:auto]"
    >
      <div
        ref={itemRef}
        tabIndex={0}
        className={cn(
          "relative flex cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-xs",
          "transition-colors duration-150 ease-out",
          "focus-visible:ring-ring/50 focus-visible:ring-1 focus-visible:outline-none",
          isSelected
            ? "bg-primary/10 text-primary"
            : "text-foreground/80 hover:bg-muted/30 hover:text-foreground",
          // Committed files are muted — they're "done", less attention needed
          !isDirectory && node.committed === true && "opacity-60"
        )}
        style={{ paddingLeft: `${indentPx + 8}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {indentGuides}

        {/* Icon */}
        <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
          {isDirectory ? (
            hasChildren ? (
              isExpanded ? (
                <ChevronDown className="text-muted-foreground/40 h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="text-muted-foreground/40 h-3.5 w-3.5" />
              )
            ) : (
              <ChevronRight className="text-muted-foreground/15 h-3.5 w-3.5" />
            )
          ) : FileIcon ? (
            <FileIcon className={cn("h-3.5 w-3.5 opacity-50", fileConfig?.color)} />
          ) : (
            <File className="text-muted-foreground/30 h-3.5 w-3.5" />
          )}
        </div>

        {/* Name */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-normal",
            isDirectory
              ? folderHasChanges
                ? "text-warning/60"
                : "text-muted-foreground/60"
              : "text-foreground/70",
            // Change status from diff data takes priority
            node.change_status === "deleted" && "line-through opacity-50",
            node.change_status === "added" && "text-success/80",
            // Fallback to git_status from file scan
            !node.change_status && node.git_status === "deleted" && "line-through opacity-50",
            !node.change_status && node.git_status === "added" && "text-success/80",
            !node.change_status && node.git_status === "untracked" && "text-info/80"
          )}
        >
          {node.name}
        </span>

        {/* Change stats (+N, -N) for files with diff data */}
        {!isDirectory && (node.additions || node.deletions) && (
          <div className="flex items-center gap-1 font-mono text-[11px] tabular-nums opacity-60">
            {node.additions ? <span className="text-success/80">+{node.additions}</span> : null}
            {node.deletions ? <span className="text-destructive/80">-{node.deletions}</span> : null}
          </div>
        )}

        {/* Uncommitted indicator — small dot for files not yet committed */}
        {!isDirectory && node.committed === false && (
          <span
            className="text-warning/70 flex-shrink-0 text-[8px] leading-none"
            title="Uncommitted"
          >
            ●
          </span>
        )}
      </div>

      {/* Children */}
      {isDirectory && isExpanded && hasChildren && (
        <FileTree
          nodes={node.children!}
          level={level + 1}
          selectedPath={selectedPath}
          onFileClick={onFileClick}
          defaultExpanded={defaultExpanded}
          revealPath={revealPath}
          revealRequestId={revealRequestId}
          onRevealConsumed={onRevealConsumed}
        />
      )}
    </div>
  );
});
