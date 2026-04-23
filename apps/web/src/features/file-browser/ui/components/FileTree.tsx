/**
 * File Tree — thin wrapper over @pierre/trees/react.
 *
 * Pierre owns rendering, virtualization, keyboard nav, VS Code icons, and
 * git-status badges. We flatten our hierarchical FileTreeNode[] into the
 * string[] shape Pierre wants, push additions/deletions/committed markers
 * via renderRowDecoration, and forward reveal + selection intents through
 * the imperative model methods.
 *
 * Live agent-activity layer (flash + dirty-folder dot):
 *   - Activity detection (write/edit/delete) runs at panel-level (see
 *     FileBrowserPanel → useActivityDetector) against the unfiltered enriched
 *     tree, so narrowing via search/sub-filter doesn't synthesize deletes.
 *   - This component only subscribes to the resulting recentActivityStore.
 *   - A short-lived CSS class is applied to the row's shadow-DOM button for
 *     each new activity, driving the flash wash defined in FLASH_UNSAFE_CSS.
 *   - When the touched file lives inside a collapsed folder, the flash rolls
 *     up to the nearest visible ancestor and that folder is marked dirty so
 *     renderRowDecoration can paint a persistent dot until the user expands.
 */

import { useEffect, useMemo, useRef } from "react";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeRowDecorationRenderer,
  GitStatusEntry,
} from "@pierre/trees";
import "@pierre/trees/web-components";

import type { FileTreeNode } from "../../types";
import { FILE_TREE_FLASH_CSS, fileTreeThemeStyles } from "../../lib/fileTreeTheme";
import {
  useRecentActivityStore,
  recentActivityActions,
  type ActivityEntry,
  type ActivityKind,
} from "../../store/recentActivityStore";

interface FileTreeProps {
  nodes: FileTreeNode[];
  /** Required for workspace-scoped activity recording + dirty-folder state. */
  workspaceId: string | null;
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

// Walk from leaf to root. If any ancestor directory is collapsed, return
// that ancestor's path so the flash lands on a visible row. Otherwise return
// the leaf path unchanged.
function isDirectoryHandle(h: FileTreeItemHandle): h is FileTreeDirectoryHandle {
  return h.isDirectory();
}

function resolveVisibleTarget(
  leafPath: string,
  model: ReturnType<typeof useFileTree>["model"]
): string {
  const segs = leafPath.split("/").filter(Boolean);
  let acc = "";
  for (let i = 0; i < segs.length - 1; i++) {
    acc += segs[i] + "/";
    const handle = model.getItem(acc);
    if (!handle || !isDirectoryHandle(handle)) continue;
    if (!handle.isExpanded()) return acc;
  }
  return leafPath;
}

// ActivityKind → CSS class. Kept in sync with FILE_TREE_FLASH_CSS in fileTreeTheme.ts.
const KIND_CLASS: Record<ActivityKind, string> = {
  write: "deus-flash-add",
  edit: "deus-flash-edit",
  delete: "deus-flash-delete",
};
const ALL_FLASH_CLASSES = Object.values(KIND_CLASS);

// Stable empty references so Zustand selectors return referentially-equal
// results when a workspace has no activity yet (avoids extra rerenders).
const EMPTY_ACTIVITIES: readonly ActivityEntry[] = Object.freeze([]);
const EMPTY_DIRTY: Readonly<Record<string, ActivityKind>> = Object.freeze({});

export function FileTree({
  nodes,
  workspaceId,
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

  // Activity detection happens at panel-level (against the UNFILTERED enriched
  // tree) so that narrowing via search/sub-filter doesn't look like deletions.
  // This component just subscribes to the resulting activity stream below.

  // Subscribe to the workspace's live activity stream and dirty-folder map.
  const activities = useRecentActivityStore((s) =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY_ACTIVITIES) : EMPTY_ACTIVITIES
  );
  const dirtyFolders = useRecentActivityStore((s) =>
    workspaceId ? (s.dirtyByWorkspace[workspaceId] ?? EMPTY_DIRTY) : EMPTY_DIRTY
  );

  // Refs keep the latest callback/data reachable from Pierre's stable closures
  // (onSelectionChange + renderRowDecoration are captured once at construction).
  // Sync to refs in an effect so we don't mutate during render — closures read
  // `.current` in response to user events, which always land post-commit.
  const onFileClickRef = useRef(onFileClick);
  const fileLookupRef = useRef(fileLookup);
  const dirtyFoldersRef = useRef(dirtyFolders);
  const workspaceIdRef = useRef(workspaceId);

  useEffect(() => {
    onFileClickRef.current = onFileClick;
    fileLookupRef.current = fileLookup;
    dirtyFoldersRef.current = dirtyFolders;
    workspaceIdRef.current = workspaceId;
  }, [onFileClick, fileLookup, dirtyFolders, workspaceId]);

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
        // Collapsed folders with unseen activity carry a persistent dot.
        if (row.kind === "directory") {
          const dirty = dirtyFoldersRef.current;
          if (!row.isExpanded) {
            if (dirty[row.path]) {
              return { text: "●", title: "Unseen activity inside" };
            }
            return null;
          }
          // Folder is expanded — if it was dirty, clear lazily. The microtask
          // defers the mutation until after this render pass completes so we
          // don't mutate store state from inside a render.
          if (dirty[row.path]) {
            const wsId = workspaceIdRef.current;
            const target = row.path;
            if (wsId) {
              queueMicrotask(() => recentActivityActions.clearDirty(wsId, target));
            }
          }
          return null;
        }

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
    unsafeCSS: FILE_TREE_FLASH_CSS,
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

  // Container ref so we can reach into Pierre's shadow root for the flash
  // class application. Pierre's React component doesn't forward refs, so we
  // query for the custom-element host from a wrapper div.
  const containerRef = useRef<HTMLDivElement>(null);

  // Tracks which (path, at) activity keys we've already applied a flash for
  // — ensures each distinct event gets exactly one animation cycle even when
  // the activities array reference changes for unrelated reasons.
  const seenActivitiesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workspaceId) return;
    const host =
      (containerRef.current?.querySelector("file-tree-container") as HTMLElement | null) ?? null;
    const shadowRoot = host?.shadowRoot ?? null;
    if (!shadowRoot) return;

    const live = new Set<string>();

    for (const entry of activities) {
      const key = `${entry.path}\u0000${entry.at}`;
      live.add(key);
      if (seenActivitiesRef.current.has(key)) continue;
      seenActivitiesRef.current.add(key);

      // Decide which row to flash. Collapsed ancestors absorb the signal.
      const target = resolveVisibleTarget(entry.path, model);
      if (target !== entry.path) {
        recentActivityActions.markDirty(workspaceId, target, entry.kind);
      }

      const row = shadowRoot.querySelector(
        `button[data-item-path="${CSS.escape(target)}"]`
      ) as HTMLElement | null;
      if (!row) continue;

      // Hard-cancel any running animation so re-flashes on the same row
      // always paint the peak again instead of being coalesced.
      try {
        row.getAnimations?.().forEach((a) => a.cancel());
      } catch {
        /* older engines — fall through to class toggle */
      }
      for (const cls of ALL_FLASH_CLASSES) row.classList.remove(cls);
      // Defensive reflow — some engines coalesce class changes without it.
      void row.offsetWidth;
      row.classList.add(KIND_CLASS[entry.kind]);
    }

    // GC keys for entries that have expired out of the store so re-hitting
    // the same path later produces a fresh flash (not deduped by stale key).
    for (const k of seenActivitiesRef.current) {
      if (!live.has(k)) seenActivitiesRef.current.delete(k);
    }
  }, [activities, workspaceId, model]);

  // Nudge Pierre to repaint when the dirty-folder set changes so the
  // decoration renderer re-runs and the dot appears/disappears promptly.
  // setComposition is idempotent at the data level but always triggers a
  // re-render of the row surface, which is exactly what we need.
  useEffect(() => {
    if (!hasMountedRef.current) return;
    model.setComposition(model.getComposition());
  }, [dirtyFolders, model]);

  return (
    <div ref={containerRef} style={{ display: "block", height: "100%", width: "100%" }}>
      <PierreFileTree model={model} style={fileTreeThemeStyles} />
    </div>
  );
}
