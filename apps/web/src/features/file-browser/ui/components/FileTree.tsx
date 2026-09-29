/**
 * File Tree — thin wrapper over @pierre/trees/react.
 *
 * Pierre owns rendering, virtualization, keyboard nav, VS Code icons, and
 * git-status badges. We flatten our hierarchical FileTreeNode[] into the
 * string[] shape Pierre wants, push additions/deletions/committed markers
 * via renderRowDecoration, and forward reveal + selection intents through
 * the imperative model methods.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeRowDecorationRenderer, GitStatusEntry } from "@pierre/trees";
import "@pierre/trees/web-components";

import type { FileTreeNode } from "../../types";
import { fileTreeThemeStyles } from "../../lib/fileTreeTheme";

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedPath?: string | null;
  onFileClick?: (path: string) => void;
  /** When true directories start expanded; when false they start collapsed. */
  defaultExpanded?: boolean;
  revealPath?: string | null;
  revealRequestId?: string | null;
  onRevealConsumed?: (requestId: string) => void;
}

// Files keep their raw path; directories get a trailing slash so Pierre
// infers kind from the string without us shipping extra metadata.
function flattenToPaths(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  const visit = (list: FileTreeNode[]) => {
    for (const node of list) {
      out.push(node.type === "directory" ? `${node.path}/` : node.path);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

function buildFileLookup(nodes: FileTreeNode[]): Map<string, FileTreeNode> {
  const map = new Map<string, FileTreeNode>();
  const visit = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (node.type === "file") map.set(node.path, node);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(nodes);
  return map;
}

// change_status (from diff) is authoritative when present; fall back
// to git_status from the file scan.
function buildGitStatus(nodes: FileTreeNode[]): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const visit = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (node.type === "file") {
        const status = node.change_status ?? node.git_status;
        if (status) entries.push({ path: node.path, status });
      }
      if (node.children?.length) visit(node.children);
    }
  };
  visit(nodes);
  return entries;
}

export function FileTree({
  nodes,
  selectedPath,
  onFileClick,
  defaultExpanded,
  revealPath,
  revealRequestId,
  onRevealConsumed,
}: FileTreeProps) {
  const { paths, gitStatus, fileLookup } = useMemo(
    () => ({
      paths: flattenToPaths(nodes),
      gitStatus: buildGitStatus(nodes),
      fileLookup: buildFileLookup(nodes),
    }),
    [nodes]
  );

  // Refs keep the latest callback/data reachable from Pierre's stable closures
  // (onSelectionChange + renderRowDecoration are captured once at construction).
  // Sync to refs in an effect so we don't mutate during render — closures read
  // `.current` in response to user events, which always land post-commit.
  const onFileClickRef = useRef(onFileClick);
  const fileLookupRef = useRef(fileLookup);

  useEffect(() => {
    onFileClickRef.current = onFileClick;
    fileLookupRef.current = fileLookup;
  }, [onFileClick, fileLookup]);

  // Controlled selection updates must not navigate the host back to an old
  // selection while Pierre emits intermediate deselection/selection callbacks.
  const syncingSelection = useRef(false);

  const handleSelectionChange = useMemo(
    () => (selectedPaths: readonly string[]) => {
      const path = selectedPaths[0];
      if (!path || path.endsWith("/")) return;
      if (syncingSelection.current) return;
      onFileClickRef.current?.(path);
    },
    []
  );

  const renderRowDecoration: FileTreeRowDecorationRenderer = useMemo(
    () =>
      ({ row }) => {
        if (row.kind === "directory") return null;

        // File decoration — +N/−N line counts plus uncommitted marker.
        const node = fileLookupRef.current.get(row.path);
        if (!node) return null;
        const parts: string[] = [];
        if (node.additions) parts.push(`+${node.additions}`);
        if (node.deletions) parts.push(`-${node.deletions}`);
        if (node.committed === false) parts.push("●");
        if (parts.length === 0) return null;
        return {
          text: parts.join(" "),
          title:
            node.additions || node.deletions
              ? `+${node.additions ?? 0} additions, -${node.deletions ?? 0} deletions`
              : "Uncommitted",
        };
      },
    []
  );

  const { model } = useFileTree({
    paths,
    initialExpansion: defaultExpanded ? "open" : "closed",
    flattenEmptyDirectories: true,
    // Monochrome icons — Pierre inherits `currentColor` from the host row
    // foreground when `colored` is off, so the whole tree reads as a single
    // neutral glyph weight instead of the vscode rainbow.
    icons: { set: "standard", colored: false },
    gitStatus,
    renderRowDecoration,
    onSelectionChange: handleSelectionChange,
  });

  // useFileTree consumed the initial paths + gitStatus. Skip the first-render
  // flush and only push imperative updates when deps actually change. Pierre
  // dedupes at the signature level, so the occasional same-content re-push
  // from a new useMemo reference is free.
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (!hasMountedRef.current) return;
    model.resetPaths(paths);
  }, [paths, model]);

  useEffect(() => {
    if (!hasMountedRef.current) return;
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    hasMountedRef.current = true;
  }, []);

  const syncSelection = useCallback(
    (path: string | null) => {
      const current = model.getSelectedPaths();
      if (current.length === (path ? 1 : 0) && (!path || current[0] === path)) return;
      syncingSelection.current = true;
      try {
        for (const selected of current) model.getItem(selected)?.deselect();
        if (path) model.getItem(path)?.select();
      } finally {
        syncingSelection.current = false;
      }
    },
    [model]
  );

  useEffect(() => {
    syncSelection(selectedPath ?? null);
  }, [selectedPath, syncSelection]);

  // Expand ancestors before focusing: Pierre can only focus a visible row.
  // Keep the selection controlled so revealing a file does not navigate twice.
  useEffect(() => {
    if (!revealRequestId || !revealPath) return;
    const segments = revealPath.split("/");
    for (let index = 1; index < segments.length; index++) {
      const ancestor = model.getItem(`${segments.slice(0, index).join("/")}/`);
      if (ancestor && "expand" in ancestor) ancestor.expand();
    }
    model.focusPath(revealPath);
    syncSelection(revealPath);
    onRevealConsumed?.(revealRequestId);
  }, [revealRequestId, revealPath, model, onRevealConsumed, syncSelection]);

  return <PierreFileTree model={model} style={fileTreeThemeStyles} />;
}
