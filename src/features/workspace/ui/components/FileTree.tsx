import { useState } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  children?: FileTreeNode[];
}

interface FileTreeProps {
  nodes: FileTreeNode[];
  onFileClick?: (path: string) => void;
  level?: number;
}

export function FileTree({ nodes, onFileClick, level = 0 }: FileTreeProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          level={level}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  level,
  onFileClick
}: {
  node: FileTreeNode;
  level: number;
  onFileClick?: (path: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(level < 2); // Auto-expand first 2 levels
  const isDirectory = node.type === 'directory';
  const hasChildren = node.children && node.children.length > 0;

  const indentSize = level * 12; // 12px per level

  return (
    <div>
      {/* Node Row */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer',
          'hover:bg-muted/30 transition-colors duration-150',
          'group'
        )}
        style={{ paddingLeft: `${indentSize + 8}px` }}
        onClick={() => {
          if (isDirectory) {
            setIsExpanded(!isExpanded);
          } else {
            onFileClick?.(node.path);
          }
        }}
      >
        {/* Expand/Collapse Icon (directories only) */}
        {isDirectory && (
          <div className="w-3 h-3 flex items-center justify-center flex-shrink-0">
            {hasChildren && (
              isExpanded
                ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                : <ChevronRight className="w-3 h-3 text-muted-foreground" />
            )}
          </div>
        )}

        {/* File/Folder Icon */}
        <div className="flex-shrink-0">
          {isDirectory ? (
            isExpanded
              ? <FolderOpen className="w-4 h-4 text-primary/70" />
              : <Folder className="w-4 h-4 text-primary/50" />
          ) : (
            <File className="w-4 h-4 text-muted-foreground/60" />
          )}
        </div>

        {/* File/Folder Name */}
        <span className={cn(
          'text-sm truncate',
          isDirectory ? 'font-medium text-foreground' : 'text-foreground/90'
        )}>
          {node.name}
        </span>

        {/* File Size (files only) */}
        {!isDirectory && node.size !== undefined && (
          <span className="text-xs text-muted-foreground/50 ml-auto font-mono tabular-nums">
            {formatFileSize(node.size)}
          </span>
        )}
      </div>

      {/* Children (if expanded) */}
      {isDirectory && isExpanded && hasChildren && (
        <FileTree
          nodes={node.children!}
          level={level + 1}
          onFileClick={onFileClick}
        />
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
