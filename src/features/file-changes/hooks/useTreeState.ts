/**
 * Tree State Hook
 * Manages expand/collapse state for the file change tree
 *
 * Features:
 * - Per-workspace persistence in localStorage
 * - Auto-expand on first load
 * - Toggle and batch update operations
 */

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { getAutoExpandPaths } from "../lib/buildFileTree";
import { FILE_TREE } from "../constants";
import type { FileChangeTreeNode } from "../types";

const STORAGE_KEY_PREFIX = "file-changes-tree-state-";

interface UseTreeStateOptions {
  /** Auto-expand directories up to this depth on first load */
  autoExpandDepth?: number;
}

interface UseTreeStateResult {
  /** Set of currently expanded directory paths */
  expandedPaths: Set<string>;
  /** Toggle a directory's expanded state */
  toggle: (path: string) => void;
  /** Expand a specific path */
  expand: (path: string) => void;
  /** Collapse a specific path */
  collapse: (path: string) => void;
  /** Expand all directories */
  expandAll: () => void;
  /** Collapse all directories */
  collapseAll: () => void;
  /** Set expanded paths explicitly */
  setExpandedPaths: (paths: Set<string>) => void;
}

/**
 * Load expanded paths from localStorage
 */
function loadFromStorage(workspaceId: string): Set<string> {
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    if (stored) {
      const paths = JSON.parse(stored);
      if (Array.isArray(paths)) {
        return new Set(paths);
      }
    }
  } catch {
    // Ignore parse errors
  }
  return new Set();
}

/**
 * Save expanded paths to localStorage
 */
function saveToStorage(workspaceId: string, paths: Set<string>): void {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${workspaceId}`, JSON.stringify([...paths]));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Collect all directory paths from tree nodes
 */
function getAllDirectoryPaths(nodes: FileChangeTreeNode[]): string[] {
  const paths: string[] = [];

  function traverse(node: FileChangeTreeNode): void {
    if (node.type === "directory") {
      paths.push(node.path);
      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    }
  }

  for (const node of nodes) {
    traverse(node);
  }

  return paths;
}

/**
 * Hook for managing file tree expand/collapse state
 *
 * @param workspaceId - Workspace ID for persistence
 * @param nodes - File tree nodes (for auto-expand calculation)
 * @param options - Configuration options
 */
export function useTreeState(
  workspaceId: string | null,
  nodes: FileChangeTreeNode[],
  options: UseTreeStateOptions = {}
): UseTreeStateResult {
  const { autoExpandDepth = FILE_TREE.AUTO_EXPAND_DEPTH } = options;

  // Track previous workspace to detect changes
  const prevWorkspaceIdRef = useRef<string | null | undefined>(undefined);
  // Track whether auto-expand has been performed for the current workspace
  // Prevents re-triggering auto-expand after user explicitly collapses all
  const hasAutoExpandedRef = useRef(false);

  // Expanded paths state - initialize lazily
  const [expandedPaths, setExpandedPathsState] = useState<Set<string>>(() => {
    if (workspaceId) {
      const stored = loadFromStorage(workspaceId);
      if (stored.size > 0) return stored;
    }
    return new Set();
  });

  // Handle workspace changes and initialization
  // Using useEffect to comply with React hooks rules
  useEffect(() => {
    // Skip first render (handled by initial state)
    if (prevWorkspaceIdRef.current === undefined) {
      prevWorkspaceIdRef.current = workspaceId;

      // Mark auto-expand done if stored state exists, or auto-expand if nodes are ready
      if (workspaceId) {
        const stored = loadFromStorage(workspaceId);
        if (stored.size > 0) {
          hasAutoExpandedRef.current = true; // Already has state, skip auto-expand
        } else if (nodes.length > 0) {
          const autoExpand = new Set(getAutoExpandPaths(nodes, autoExpandDepth));
          setExpandedPathsState(autoExpand);
          saveToStorage(workspaceId, autoExpand);
          hasAutoExpandedRef.current = true;
        }
      }
      return;
    }

    // Workspace changed
    if (workspaceId !== prevWorkspaceIdRef.current) {
      prevWorkspaceIdRef.current = workspaceId;
      hasAutoExpandedRef.current = false; // Reset for new workspace

      if (!workspaceId) {
        setExpandedPathsState(new Set());
        return;
      }

      // Load stored state or auto-expand
      const stored = loadFromStorage(workspaceId);
      if (stored.size > 0) {
        setExpandedPathsState(stored);
        hasAutoExpandedRef.current = true;
      } else if (nodes.length > 0) {
        const autoExpand = new Set(getAutoExpandPaths(nodes, autoExpandDepth));
        setExpandedPathsState(autoExpand);
        saveToStorage(workspaceId, autoExpand);
        hasAutoExpandedRef.current = true;
      } else {
        setExpandedPathsState(new Set());
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only react to workspace changes
  }, [workspaceId]);

  // Auto-expand when nodes load for the first time (e.g., async data arrived)
  // Skip if auto-expand was already performed (including after user's collapse-all)
  useEffect(() => {
    if (!workspaceId || nodes.length === 0 || hasAutoExpandedRef.current) return;

    const stored = loadFromStorage(workspaceId);
    if (stored.size === 0 && expandedPaths.size === 0) {
      const autoExpand = new Set(getAutoExpandPaths(nodes, autoExpandDepth));
      if (autoExpand.size > 0) {
        setExpandedPathsState(autoExpand);
        saveToStorage(workspaceId, autoExpand);
      }
      hasAutoExpandedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only auto-expand when node count changes, not on every node update
  }, [nodes.length]);

  // Persist changes
  const setExpandedPaths = useCallback(
    (paths: Set<string>) => {
      setExpandedPathsState(paths);
      if (workspaceId) {
        saveToStorage(workspaceId, paths);
      }
    },
    [workspaceId]
  );

  // Toggle a single path
  const toggle = useCallback(
    (path: string) => {
      setExpandedPathsState((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        if (workspaceId) {
          saveToStorage(workspaceId, next);
        }
        return next;
      });
    },
    [workspaceId]
  );

  // Expand a single path
  const expand = useCallback(
    (path: string) => {
      setExpandedPathsState((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        if (workspaceId) {
          saveToStorage(workspaceId, next);
        }
        return next;
      });
    },
    [workspaceId]
  );

  // Collapse a single path
  const collapse = useCallback(
    (path: string) => {
      setExpandedPathsState((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        if (workspaceId) {
          saveToStorage(workspaceId, next);
        }
        return next;
      });
    },
    [workspaceId]
  );

  // Expand all directories
  const expandAll = useCallback(() => {
    const allPaths = new Set(getAllDirectoryPaths(nodes));
    setExpandedPathsState(allPaths);
    if (workspaceId) {
      saveToStorage(workspaceId, allPaths);
    }
  }, [nodes, workspaceId]);

  // Collapse all directories
  const collapseAll = useCallback(() => {
    setExpandedPathsState(new Set());
    hasAutoExpandedRef.current = true; // Prevent auto-expand from re-triggering
    if (workspaceId) {
      saveToStorage(workspaceId, new Set());
    }
  }, [workspaceId]);

  return useMemo(
    () => ({
      expandedPaths,
      toggle,
      expand,
      collapse,
      expandAll,
      collapseAll,
      setExpandedPaths,
    }),
    [expandedPaths, toggle, expand, collapse, expandAll, collapseAll, setExpandedPaths]
  );
}
