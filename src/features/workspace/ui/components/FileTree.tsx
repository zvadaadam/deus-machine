import { useState } from 'react';
import { ChevronRight, ChevronDown, File, FileText, FileCode, FileJson, FileImage, FileType } from 'lucide-react';
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

/**
 * Get file icon and color based on file extension
 * Inspired by VS Code's icon theme
 */
function getFileIconConfig(filename: string): { icon: typeof File; color: string } {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  // TypeScript/JavaScript
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return { icon: FileCode, color: 'text-blue-500' };
  }

  // Markup/Data
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return { icon: FileJson, color: 'text-yellow-500' };
  }

  // Documentation
  if (['md', 'mdx', 'txt', 'rst'].includes(ext)) {
    return { icon: FileText, color: 'text-green-500' };
  }

  // Styles
  if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    return { icon: FileCode, color: 'text-purple-500' };
  }

  // HTML
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) {
    return { icon: FileCode, color: 'text-orange-500' };
  }

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) {
    return { icon: FileImage, color: 'text-pink-500' };
  }

  // Rust
  if (['rs', 'toml'].includes(ext)) {
    return { icon: FileCode, color: 'text-orange-600' };
  }

  // Config files
  if (['env', 'gitignore', 'dockerignore', 'editorconfig'].includes(ext) || filename.startsWith('.')) {
    return { icon: FileType, color: 'text-muted-foreground/50' };
  }

  // Default
  return { icon: File, color: 'text-muted-foreground/40' };
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

  const indentSize = level * 16; // 16px per level (improved from 12px)

  // Get file-specific icon and color
  const fileConfig = !isDirectory ? getFileIconConfig(node.name) : null;
  const FileIcon = fileConfig?.icon;

  return (
    <div>
      {/* Node Row */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1 rounded cursor-pointer',
          'hover:bg-accent/50 transition-colors duration-200',
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
        {/* Single Icon Column - Chevron for folders, File icon for files */}
        <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">
          {isDirectory ? (
            // Folders: Show chevron only
            hasChildren ? (
              isExpanded ? (
                <ChevronDown className="w-4 h-4 text-foreground/60" />
              ) : (
                <ChevronRight className="w-4 h-4 text-foreground/60" />
              )
            ) : (
              // Empty folder - show faint chevron
              <ChevronRight className="w-4 h-4 text-muted-foreground/20" />
            )
          ) : FileIcon ? (
            // Files: Show colored icon
            <FileIcon className={cn('w-4 h-4', fileConfig?.color)} />
          ) : (
            <File className="w-4 h-4 text-muted-foreground/40" />
          )}
        </div>

        {/* File/Folder Name */}
        <span className={cn(
          'text-[13px] truncate flex-1',
          isDirectory ? 'font-semibold text-foreground' : 'font-medium text-foreground'
        )}>
          {node.name}
        </span>

        {/* File Size (files only) */}
        {!isDirectory && node.size !== undefined && (
          <span className="text-[11px] text-muted-foreground/40 font-mono tabular-nums flex-shrink-0">
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
