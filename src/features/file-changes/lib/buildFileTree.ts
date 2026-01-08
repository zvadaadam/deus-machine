/**
 * Build File Tree
 * Transforms flat file paths into a hierarchical tree structure
 *
 * Algorithm:
 * 1. Create a temporary map of path → node for O(1) lookups
 * 2. For each file, ensure all parent directories exist
 * 3. Insert file at correct location in tree
 * 4. Sort: directories first, then alphabetically
 */

import type { FileChangeTreeNode, FileChangeStatus } from "../types";

/**
 * Input file change from the API
 */
interface FileChange {
  file: string;
  file_path?: string;
  additions: number;
  deletions: number;
}

/**
 * Determine file status based on additions/deletions
 * - added: Only additions, no deletions (new file)
 * - deleted: Only deletions, no additions (removed file)
 * - modified: Both additions and deletions (changed file)
 */
function getFileStatus(additions: number, deletions: number): FileChangeStatus {
  if (additions > 0 && deletions === 0) return "added";
  if (deletions > 0 && additions === 0) return "deleted";
  return "modified";
}

/**
 * Build a hierarchical file tree from flat file paths
 *
 * @param files - Array of file changes from the API
 * @returns Root-level nodes of the file tree
 *
 * @example
 * buildFileTree([
 *   { file: 'src/components/Button.tsx', additions: 10, deletions: 2 },
 *   { file: 'src/components/Input.tsx', additions: 5, deletions: 0 },
 *   { file: 'README.md', additions: 3, deletions: 1 },
 * ])
 * // Returns:
 * [
 *   { name: 'src', type: 'directory', children: [
 *     { name: 'components', type: 'directory', children: [
 *       { name: 'Button.tsx', type: 'file', status: 'modified', ... },
 *       { name: 'Input.tsx', type: 'file', status: 'added', ... },
 *     ]}
 *   ]},
 *   { name: 'README.md', type: 'file', status: 'modified', ... }
 * ]
 */
export function buildFileTree(files: FileChange[]): FileChangeTreeNode[] {
  // Map of path → node for O(1) lookups
  const nodeMap = new Map<string, FileChangeTreeNode>();
  // Root level nodes
  const rootNodes: FileChangeTreeNode[] = [];

  for (const file of files) {
    const filePath = file.file || file.file_path || "";
    if (!filePath) continue;

    const parts = filePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let currentPath = "";

    // Create/get all parent directories
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!nodeMap.has(currentPath)) {
        const dirNode: FileChangeTreeNode = {
          name: part,
          path: currentPath,
          type: "directory",
          children: [],
        };
        nodeMap.set(currentPath, dirNode);

        // Add to parent or root
        if (parentPath) {
          const parent = nodeMap.get(parentPath);
          parent?.children?.push(dirNode);
        } else {
          rootNodes.push(dirNode);
        }
      }
    }

    // Create file node
    const fileName = parts[parts.length - 1];
    const fileNode: FileChangeTreeNode = {
      name: fileName,
      path: filePath,
      type: "file",
      status: getFileStatus(file.additions, file.deletions),
      additions: file.additions,
      deletions: file.deletions,
    };

    // Add to parent directory or root
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = nodeMap.get(parentPath);
      parent?.children?.push(fileNode);
    } else {
      rootNodes.push(fileNode);
    }
  }

  // Sort all nodes recursively
  sortNodes(rootNodes);

  // Skip single root folder - if there's only one root directory,
  // return its children instead (like GitHub PR view)
  return stripSingleRootFolder(rootNodes);
}

/**
 * Strip single root folder from tree (ONE level only)
 * If there's exactly one root node and it's a directory, return its children.
 * Only strips ONE level - keeps nested folders intact.
 *
 * Examples:
 * - [BetterMind/[AppIntents/...]] → [AppIntents/...] (stripped one level)
 * - [src/, README.md] → [src/, README.md] (kept - multiple roots)
 * - [file.txt] → [file.txt] (kept - single file)
 */
function stripSingleRootFolder(nodes: FileChangeTreeNode[]): FileChangeTreeNode[] {
  // If exactly one root node that is a directory with children, skip it (ONE level only)
  if (
    nodes.length === 1 &&
    nodes[0].type === "directory" &&
    nodes[0].children &&
    nodes[0].children.length > 0
  ) {
    return nodes[0].children;
  }
  return nodes;
}

/**
 * Sort nodes: directories first, then alphabetically by name
 * Modifies the array in place and recurses into children
 */
function sortNodes(nodes: FileChangeTreeNode[]): void {
  nodes.sort((a, b) => {
    // Directories before files
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    // Alphabetically by name (case-insensitive)
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  // Recurse into children
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      sortNodes(node.children);
    }
  }
}

/**
 * Get all file paths from a tree (flattened)
 * Useful for computing total stats or filtering
 */
export function getFilePaths(nodes: FileChangeTreeNode[]): string[] {
  const paths: string[] = [];

  function traverse(node: FileChangeTreeNode): void {
    if (node.type === "file") {
      paths.push(node.path);
    } else if (node.children) {
      for (const child of node.children) {
        traverse(child);
      }
    }
  }

  for (const node of nodes) {
    traverse(node);
  }

  return paths;
}

/**
 * Find a node by path in the tree
 */
export function findNodeByPath(
  nodes: FileChangeTreeNode[],
  path: string
): FileChangeTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Get all directory paths that should be auto-expanded
 * Expands directories up to a certain depth
 */
export function getAutoExpandPaths(nodes: FileChangeTreeNode[], maxDepth: number = 2): string[] {
  const paths: string[] = [];

  function traverse(node: FileChangeTreeNode, depth: number): void {
    if (node.type === "directory" && depth < maxDepth) {
      paths.push(node.path);
      if (node.children) {
        for (const child of node.children) {
          traverse(child, depth + 1);
        }
      }
    }
  }

  for (const node of nodes) {
    traverse(node, 0);
  }

  return paths;
}
