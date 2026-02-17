/**
 * File Tree Node
 * Renders a single node in the file change tree (file or directory)
 *
 * Features:
 * - Click folders to expand/collapse (no chevron arrows)
 * - Hover-only indent guide lines showing hierarchy
 * - File status indicators
 * - Keyboard navigation support
 */

import { memo, useCallback } from "react";
import { Folder, FolderOpen, FileText } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { cn } from "@/shared/lib/utils";
import type { FileChangeTreeNode } from "../types";
import { FILE_TREE } from "../constants";

interface FileTreeNodeProps {
  node: FileChangeTreeNode;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

/**
 * Memoized tree node component
 * Prevents unnecessary re-renders when tree state changes
 */
export const FileTreeNode = memo(function FileTreeNode({
  node,
  depth,
  isExpanded,
  isSelected,
  onToggle,
  onSelect,
}: FileTreeNodeProps) {
  const isDirectory = node.type === "directory";
  const indentPx = depth * FILE_TREE.INDENT_SIZE_PX;

  const handleClick = useCallback(() => {
    if (isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  }, [isDirectory, node.path, onToggle, onSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleClick();
      }
      // Left arrow collapses, Right arrow expands (for directories)
      if (isDirectory) {
        if (e.key === "ArrowLeft" && isExpanded) {
          e.preventDefault();
          onToggle(node.path);
        } else if (e.key === "ArrowRight" && !isExpanded) {
          e.preventDefault();
          onToggle(node.path);
        }
      }
    },
    [isDirectory, isExpanded, node.path, onToggle, handleClick]
  );

  // Generate indent guide lines for each depth level
  const indentGuides = [];
  for (let i = 0; i < depth; i++) {
    indentGuides.push(
      <span
        key={i}
        className="bg-border/50 absolute top-0 bottom-0 w-px opacity-0 transition-opacity duration-150 group-hover/tree:opacity-100"
        style={{ left: `${i * FILE_TREE.INDENT_SIZE_PX + 12}px` }}
      />
    );
  }

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-expanded={isDirectory ? isExpanded : undefined}
      aria-selected={isSelected}
      className={cn(
        "relative flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-sm",
        "transition-colors duration-150 ease-out",
        "focus-visible:ring-primary/50 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-none",
        isSelected
          ? "bg-primary/10 text-primary"
          : "text-foreground/80 hover:bg-muted/30 hover:text-foreground"
      )}
      style={{ paddingLeft: `${indentPx + 8}px` }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Indent guide lines (show on tree hover) */}
      {indentGuides}

      {/* Icon - folders are whisper-light, files slightly more visible */}
      {isDirectory ? (
        isExpanded ? (
          <FolderOpen className="text-muted-foreground/30 h-4 w-4 flex-shrink-0" />
        ) : (
          <Folder className="text-muted-foreground/25 h-4 w-4 flex-shrink-0" />
        )
      ) : (
        <FileText className="text-muted-foreground/50 h-4 w-4 flex-shrink-0" />
      )}

      {/* Name - folders are navigation (subtle), files are content (prominent) */}
      {/* Deleted files get strikethrough - semantic honesty, not decoration */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-base",
          isDirectory ? "text-muted-foreground/50 font-normal" : "text-foreground/90 font-medium",
          node.status === "deleted" && "line-through opacity-50"
        )}
      >
        {node.name}
      </span>

      {/* Stats (files only) - muted pastel colors */}
      {node.type === "file" && (node.additions || node.deletions) && (
        <div className="flex items-center gap-1.5 font-mono text-2xs tabular-nums opacity-60">
          {node.additions ? <NumberFlow value={node.additions} prefix="+" className="text-success/80" /> : null}
          {node.deletions ? <NumberFlow value={node.deletions} prefix="-" className="text-destructive/80" /> : null}
        </div>
      )}
    </div>
  );
});
