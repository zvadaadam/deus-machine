import type { ProjectFile } from "@shared/projects";
import type { FileTreeNode } from "@/features/file-browser/types";

/** Project manifests describe versioned files, independent of a workspace filesystem. */
export function buildProjectFileTree(files: readonly ProjectFile[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const nodes = new Map<string, FileTreeNode>();
  for (const file of files) {
    const parts = file.path.split("/");
    let siblings = roots;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let node = nodes.get(path);
      if (!node) {
        node = isFile
          ? { name: parts[index], path, type: "file", size: file.size }
          : { name: parts[index], path, type: "directory", children: [] };
        nodes.set(path, node);
        siblings.push(node);
      }
      if (node.children) siblings = node.children;
    }
  }
  const sort = (siblings: FileTreeNode[]) => {
    siblings.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    for (const node of siblings) if (node.children) sort(node.children);
  };
  sort(roots);
  return roots;
}
