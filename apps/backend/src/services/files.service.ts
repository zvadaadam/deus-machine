import { runGit } from "@shared/lib/git-process";
import fs from "fs";
import path from "path";
import { PROJECT_ENVIRONMENT_PATH } from "@deus-hq/api";
import type { FileMatch, FileTreeNode, FileTreeResponse } from "@shared/types/files";
import { isBinaryContent } from "../lib/file-content";

/** In-memory cache with TTL to avoid rescanning on every request. */
const scanCache = new Map<string, { data: Promise<FileTreeResponse>; expiresAt: number }>();
const CACHE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 8;

/** Directories to skip when not in a git repo (or as extra safety). */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
  ".vite",
  ".parcel-cache",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  "target",
  ".deus",
  ".conductor",
  ".context",
]);

const MAX_ENTRIES = 25_000;
const GIT_TIMEOUT_MS = 20_000;

/**
 * Scan workspace files using git ls-files (preferred) with fallback to readdir.
 * Returns a tree structure matching the FileTreeResponse shape the frontend expects.
 */
export async function scanWorkspaceFiles(workspacePath: string): Promise<FileTreeResponse> {
  const cached = scanCache.get(workspacePath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // Evict oldest if cache is full
  if (scanCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...scanCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) scanCache.delete(oldest[0]);
  }

  // Publish the pending scan so invalidation during git's read also drops its result.
  const entry = { data: readFileTree(workspacePath), expiresAt: Infinity };
  scanCache.set(workspacePath, entry);
  try {
    const result = await entry.data;
    entry.expiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (error) {
    if (scanCache.get(workspacePath) === entry) scanCache.delete(workspacePath);
    throw error;
  }
}

/** Invalidate cache for a specific workspace. */
export function invalidateCache(workspacePath: string): void {
  scanCache.delete(workspacePath);
}

/** Clear the entire cache. */
export function clearCache(): void {
  scanCache.clear();
}

async function readFileTree(workspacePath: string): Promise<FileTreeResponse> {
  const paths = await listWorkspacePaths(workspacePath);
  // The recipe must remain editable even in projects that ignore the .deus folder.
  if (
    !paths.includes(PROJECT_ENVIRONMENT_PATH) &&
    fs.existsSync(path.join(workspacePath, PROJECT_ENVIRONMENT_PATH))
  )
    paths.push(PROJECT_ENVIRONMENT_PATH);
  return buildTree(workspacePath, paths);
}

async function listWorkspacePaths(workspacePath: string): Promise<string[]> {
  try {
    const output = await runGit(
      ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"],
      { cwd: workspacePath, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 50 * 1024 * 1024 }
    );
    return output.split("\0", MAX_ENTRIES).filter(Boolean);
  } catch {
    return scanWithReaddir(workspacePath);
  }
}

/**
 * Fallback: recursive readdir with hardcoded ignore list.
 * Used when workspace is not a git repo.
 */
function scanWithReaddir(workspacePath: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= MAX_ENTRIES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or deleted mid-scan
    }

    for (const entry of entries) {
      if (results.length >= MAX_ENTRIES) return;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const rel = path.relative(workspacePath, path.join(dir, entry.name));
        results.push(rel);
      }
    }
  }

  walk(workspacePath);
  return results;
}

/**
 * Build a hierarchical tree from a flat list of file paths.
 * Mirrors the FileTreeNode structure expected by the frontend.
 */
function buildTree(workspacePath: string, filePaths: string[]): FileTreeResponse {
  // Root children (top-level nodes)
  const rootMap = new Map<string, FileTreeNode>();
  let totalFiles = 0;
  let totalSize = 0;

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    let currentMap = rootMap;
    let currentChildren: FileTreeNode[] | undefined;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join("/");

      if (isLast) {
        // File node
        let fileSize = 0;
        try {
          const stat = fs.statSync(path.join(workspacePath, filePath));
          fileSize = stat.size;
          totalSize += fileSize;
        } catch {
          // File may have been deleted between scan and stat
        }

        const fileNode: FileTreeNode = {
          name: part,
          path: currentPath,
          type: "file",
          size: fileSize,
        };

        if (currentChildren) {
          currentChildren.push(fileNode);
        } else {
          currentMap.set(part, fileNode);
        }
        totalFiles++;
      } else {
        // Directory node — get or create
        let dirNode: FileTreeNode | undefined;

        if (currentChildren) {
          dirNode = currentChildren.find((n) => n.name === part && n.type === "directory");
          if (!dirNode) {
            dirNode = { name: part, path: currentPath, type: "directory", children: [] };
            currentChildren.push(dirNode);
          }
        } else {
          dirNode = currentMap.get(part);
          if (!dirNode) {
            dirNode = { name: part, path: currentPath, type: "directory", children: [] };
            currentMap.set(part, dirNode);
          }
        }

        currentChildren = dirNode.children!;
        // Switch to using children array for deeper levels
        currentMap = undefined as any;
      }
    }
  }

  // Convert root map to sorted array
  const files = sortTree([...rootMap.values()]);

  return { files, totalFiles, totalSize };
}

/** Sort tree: directories first (alphabetically), then files (alphabetically). */
function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of nodes) {
    if (node.children) {
      node.children = sortTree(node.children);
    }
  }

  return nodes;
}

/**
 * Return the top N files, preferring shorter paths (more prominent files).
 * Used when the user opens the @ mention popover without typing a query yet.
 */
export async function listTopFiles(
  workspacePath: string,
  limit: number = 15
): Promise<FileMatch[]> {
  return scoreTopFiles(await listWorkspacePaths(workspacePath), limit);
}

/** Depth/length scoring over ANY flat path list — cloud trees reuse this. */
export function scoreTopFiles(filePaths: string[], limit: number = 15): FileMatch[] {
  // Score by path depth (fewer segments = higher score) and shorter names
  const scored = filePaths.map((filePath) => {
    const name = filePath.split("/").pop() || filePath;
    const depth = filePath.split("/").length;
    const score = 100 - depth * 10 - filePath.length * 0.1;
    return { path: filePath, name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function fuzzySearchFiles(
  workspacePath: string,
  query: string,
  limit: number = 15
): Promise<FileMatch[]> {
  return fuzzySearchPaths(await listWorkspacePaths(workspacePath), query, limit);
}

/** Subsequence scoring over ANY flat path list — cloud trees reuse this. */
export function fuzzySearchPaths(
  filePaths: string[],
  query: string,
  limit: number = 15
): FileMatch[] {
  const lowerQuery = query.toLowerCase();
  const scored: FileMatch[] = [];

  for (const filePath of filePaths) {
    const lowerPath = filePath.toLowerCase();
    const name = filePath.split("/").pop() || filePath;
    const lowerName = name.toLowerCase();

    // Must contain all query characters in order (subsequence match)
    let score = 0;
    let qi = 0;
    for (let i = 0; i < lowerPath.length && qi < lowerQuery.length; i++) {
      if (lowerPath[i] === lowerQuery[qi]) {
        qi++;
        // Bonus for matching at word boundaries (after / or . or - or _)
        if (i === 0 || "/.-_".includes(lowerPath[i - 1])) score += 3;
        else score += 1;
      }
    }

    // All query chars must match
    if (qi < lowerQuery.length) continue;

    // Bonus for exact filename match
    if (lowerName.includes(lowerQuery)) score += 10;
    // Bonus for filename starts-with
    if (lowerName.startsWith(lowerQuery)) score += 5;
    // Slight penalty for longer paths (prefer shorter, more specific matches)
    score -= filePath.length * 0.01;

    scored.push({ path: filePath, name, score });
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Read a text file from the working tree.
 * Returns null for binary files (null bytes in first 8KB).
 */
export function readTextFile(filePath: string): string | null {
  const buf = fs.readFileSync(filePath);
  return isBinaryContent(buf) ? null : buf.toString("utf-8");
}
