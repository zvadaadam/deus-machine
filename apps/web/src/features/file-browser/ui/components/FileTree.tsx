/**
 * File Tree — thin wrapper over @pierre/trees/react.
 *
 * Pierre owns rendering, virtualization, keyboard nav, VS Code icons, and
 * git-status badges. We flatten our hierarchical FileTreeNode[] into the
 * string[] shape Pierre wants, show line counts and rename origins
 * via renderRowDecoration, and forward reveal + selection intents through
 * the imperative model methods.
 */

import { useEffect, useMemo, useRef } from "react";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeRowDecorationRenderer, GitStatusEntry } from "@pierre/trees";
import "@pierre/trees/web-components";

import type { FileTreeNode } from "../../types";
import { fileTreeThemeStyles } from "../../lib/fileTreeTheme";

interface FileTreeProps {
  nodes: FileTreeNode[];
  selectedPath?: string | null;
  onFileClick?: (path: string) => void;
  revealPath?: string | null;
  revealRequestId?: string | null;
  onRevealConsumed?: (requestId: string) => void;
}

function flattenTree(nodes: FileTreeNode[]) {
  const paths: string[] = [];
  const fileLookup = new Map<string, FileTreeNode>();
  const gitStatus: GitStatusEntry[] = [];

  function visit(list: FileTreeNode[]) {
    for (const node of list) {
      if (node.type === "directory") {
        // Pierre recognizes directories by their trailing slash.
        paths.push(`${node.path}/`);
        if (node.children) visit(node.children);
      } else {
        paths.push(node.path);
        fileLookup.set(node.path, node);
        if (node.change_status) gitStatus.push({ path: node.path, status: node.change_status });
      }
    }
  }

  visit(nodes);
  return { paths, gitStatus, fileLookup };
}

export function FileTree({
  nodes,
  selectedPath,
  onFileClick,
  revealPath,
  revealRequestId,
  onRevealConsumed,
}: FileTreeProps) {
  const { paths, gitStatus, fileLookup } = useMemo(() => flattenTree(nodes), [nodes]);

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

  // When we programmatically `.select()` a path to mirror controlled state,
  // Pierre still emits onSelectionChange. Record the path we just pushed so
  // we can ignore its echo and avoid an onFileClick loop.
  const programmaticSelectRef = useRef<string | null>(null);

  const handleSelectionChange = useMemo(
    () => (selectedPaths: readonly string[]) => {
      const path = selectedPaths[0];
      if (!path || path.endsWith("/")) return;
      if (programmaticSelectRef.current === path) {
        programmaticSelectRef.current = null;
        return;
      }
      onFileClickRef.current?.(path);
    },
    []
  );

  const renderRowDecoration: FileTreeRowDecorationRenderer = useMemo(
    () =>
      ({ row }) => {
        if (row.kind === "directory") return null;

        const node = fileLookupRef.current.get(row.path);
        if (!node) return null;
        const origin = node.previous_path && `Renamed from ${node.previous_path}`;
        const parts: string[] = origin ? [origin] : [];
        if (node.additions) parts.push(`+${node.additions}`);
        if (node.deletions) parts.push(`-${node.deletions}`);
        if (parts.length === 0) return null;
        return {
          text: parts.join(" "),
          title: origin ?? `+${node.additions ?? 0} additions, -${node.deletions ?? 0} deletions`,
        };
      },
    []
  );

  const { model } = useFileTree({
    paths,
    initialExpansion: "closed",
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

  useEffect(() => {
    if (!selectedPath) return;
    const handle = model.getItem(selectedPath);
    if (!handle || handle.isSelected()) return;
    programmaticSelectRef.current = selectedPath;
    handle.select();
  }, [selectedPath, model]);

  // focusPath expands ancestors + emits a focus change; Pierre's scroll
  // target helper then scrolls the row into view. We also select so the
  // FileViewer switches to the revealed file.
  useEffect(() => {
    if (!revealRequestId || !revealPath) return;
    model.focusPath(revealPath);
    const handle = model.getItem(revealPath);
    if (handle && !handle.isSelected()) {
      programmaticSelectRef.current = revealPath;
      handle.select();
    }
    onRevealConsumed?.(revealRequestId);
  }, [revealRequestId, revealPath, model, onRevealConsumed]);

  return <PierreFileTree model={model} style={fileTreeThemeStyles} />;
}
