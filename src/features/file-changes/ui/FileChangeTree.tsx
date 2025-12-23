/**
 * File Change Tree
 * Renders a hierarchical tree of changed files with expand/collapse functionality
 *
 * Features:
 * - Collapsible directories with persisted state
 * - File status indicators (added/modified/deleted)
 * - Selection highlighting
 * - Keyboard navigation
 */

import { useMemo } from "react";
import { FileTreeNode } from "./FileTreeNode";
import type { FileChangeTreeNode } from "../types";

interface FileChangeTreeProps {
  /** Root nodes of the file tree */
  nodes: FileChangeTreeNode[];
  /** Set of expanded directory paths */
  expandedPaths: Set<string>;
  /** Currently selected file path */
  selectedPath: string | null;
  /** Toggle directory expand/collapse */
  onToggle: (path: string) => void;
  /** Select a file (triggers scroll to file) */
  onSelect: (path: string) => void;
}

/**
 * File change tree with recursive rendering
 */
export function FileChangeTree({
  nodes,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect,
}: FileChangeTreeProps) {
  // Memoize the rendered tree with recursive helper inside
  const renderedTree = useMemo(() => {
    // Define recursive render function inside useMemo
    function renderNodes(nodeList: FileChangeTreeNode[], depth: number = 0): React.ReactNode {
      return nodeList.map((node) => {
        const isExpanded = expandedPaths.has(node.path);
        const isSelected = node.path === selectedPath;

        return (
          <div key={node.path} role="group">
            <FileTreeNode
              node={node}
              depth={depth}
              isExpanded={isExpanded}
              isSelected={isSelected}
              onToggle={onToggle}
              onSelect={onSelect}
            />

            {/* Render children if expanded */}
            {node.type === "directory" && isExpanded && node.children && (
              <div role="group" aria-label={`${node.name} contents`}>
                {renderNodes(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      });
    }

    return renderNodes(nodes);
  }, [nodes, expandedPaths, selectedPath, onToggle, onSelect]);

  if (nodes.length === 0) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-8 text-sm">
        No file changes
      </div>
    );
  }

  return (
    <div role="tree" aria-label="File changes" className="group/tree py-1">
      {renderedTree}
    </div>
  );
}
