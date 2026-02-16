import { useState } from "react";
import { match } from "ts-pattern";
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
import { formatFileSize } from "@/shared/lib/formatters";
import type { FileTreeNode } from "../../types";

interface FileTreeProps {
  nodes: FileTreeNode[];
  onFileClick?: (path: string) => void;
  level?: number;
}

/**
 * Get file icon and color based on file extension
 * Inspired by VS Code's icon theme
 * Uses semantic color variables from global.css for consistency
 */
function getFileIconConfig(filename: string): { icon: typeof File; color: string } {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  // TypeScript/JavaScript
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    return { icon: FileCode, color: "text-file-typescript" };
  }

  // Rust (check before Data to prioritize .toml for Rust projects)
  if (["rs", "toml"].includes(ext)) {
    return { icon: FileCode, color: "text-file-rust" };
  }

  // Markup/Data
  if (["json", "yaml", "yml", "xml"].includes(ext)) {
    return { icon: FileJson, color: "text-file-data" };
  }

  // Documentation
  if (["md", "mdx", "txt", "rst"].includes(ext)) {
    return { icon: FileText, color: "text-file-docs" };
  }

  // Styles
  if (["css", "scss", "sass", "less"].includes(ext)) {
    return { icon: FileCode, color: "text-file-styles" };
  }

  // HTML
  if (["html", "htm"].includes(ext)) {
    return { icon: FileCode, color: "text-file-markup" };
  }

  // Images (includes svg since they're primarily used as images)
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) {
    return { icon: FileImage, color: "text-file-image" };
  }

  // Config files
  if (
    ["env", "gitignore", "dockerignore", "editorconfig"].includes(ext) ||
    filename.startsWith(".")
  ) {
    return { icon: FileType, color: "text-muted-foreground/50" };
  }

  // Default
  return { icon: File, color: "text-muted-foreground/40" };
}

/**
 * Get subtle color accent for git status
 * Subtle hints, not overwhelming - this is a secondary feature
 */
function getGitStatusColor(gitStatus?: "modified" | "added" | "deleted" | "untracked"): string {
  if (!gitStatus) return "";

  return match(gitStatus)
    .with("modified", () => "text-warning")
    .with("added", () => "text-success")
    .with("deleted", () => "text-destructive/60 line-through")
    .with("untracked", () => "text-info")
    .exhaustive();
}

/**
 * Check if a folder contains any changed files (recursively)
 */
function hasChanges(node: FileTreeNode): boolean {
  if (node.type === "file") {
    return !!node.git_status;
  }

  // Check if any children have changes
  return node.children?.some((child) => hasChanges(child)) || false;
}

export function FileTree({ nodes, onFileClick, level = 0 }: FileTreeProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} level={level} onFileClick={onFileClick} />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  level,
  onFileClick,
}: {
  node: FileTreeNode;
  level: number;
  onFileClick?: (path: string) => void;
}) {
  // Auto-expand:
  // 1. First 2 levels always expanded
  // 2. Folders containing changes auto-expanded
  const shouldAutoExpand = level < 2 || (node.type === "directory" && hasChanges(node));
  const [isExpanded, setIsExpanded] = useState(shouldAutoExpand);

  const isDirectory = node.type === "directory";
  const hasChildren = node.children && node.children.length > 0;

  const indentSize = level * 16; // 16px per level (improved from 12px)

  // Get file-specific icon and color
  const fileConfig = !isDirectory ? getFileIconConfig(node.name) : null;
  const FileIcon = fileConfig?.icon;

  // Get git status color (subtle accent for changed files)
  const gitStatusColor = !isDirectory ? getGitStatusColor(node.git_status) : "";
  const folderHasChanges = isDirectory && hasChanges(node);

  return (
    <div>
      {/* Node Row */}
      <div
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5",
          "hover:bg-muted/30 transition-colors duration-200",
          "group"
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
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {isDirectory ? (
            // Folders: Show whisper-light chevron
            hasChildren ? (
              isExpanded ? (
                <ChevronDown className="text-muted-foreground/40 h-4 w-4" />
              ) : (
                <ChevronRight className="text-muted-foreground/40 h-4 w-4" />
              )
            ) : (
              // Empty folder - show very faint chevron
              <ChevronRight className="text-muted-foreground/15 h-4 w-4" />
            )
          ) : FileIcon ? (
            // Files: Show colored icon (very muted like VS Code)
            <FileIcon className={cn("h-4 w-4 opacity-50", fileConfig?.color)} />
          ) : (
            <File className="text-muted-foreground/30 h-4 w-4" />
          )}
        </div>

        {/* File/Folder Name - VS Code style: subtle, readable, not bold */}
        <span
          className={cn(
            "flex-1 truncate text-[13px] font-normal",
            // VS Code style: muted gray, consistent weight
            // Folders with changes get subtle warning tint, otherwise muted
            isDirectory
              ? folderHasChanges
                ? "text-warning/60"
                : "text-muted-foreground/60"
              : "text-foreground/70",
            // Git status color (subtle accent - files only)
            gitStatusColor
          )}
        >
          {node.name}
        </span>

        {/* File Size (files only) */}
        {!isDirectory && node.size !== undefined && (
          <span className="text-muted-foreground/30 flex-shrink-0 font-mono text-[10px] tabular-nums">
            {formatFileSize(node.size)}
          </span>
        )}
      </div>

      {/* Children (if expanded) */}
      {isDirectory && isExpanded && hasChildren && (
        <FileTree nodes={node.children!} level={level + 1} onFileClick={onFileClick} />
      )}
    </div>
  );
}
