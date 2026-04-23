/**
 * useActivityDetector
 *
 * Watches the enriched file-browser tree's per-path snapshot and emits
 * write/edit/delete activities into the recentActivityStore. Driven entirely
 * by the data the file-browser already recomputes on file-watch / git-status
 * updates — no extra backend event subscription or tool-call plumbing.
 *
 * IMPORTANT: pass the UNFILTERED enriched tree, not a UI-filtered subset.
 * Filtering narrows `nodes` without representing real filesystem activity, so
 * feeding a filtered subset here would make every filtered-out path look like
 * a deletion on narrow (flood of red flashes) and a fresh write on widen.
 * The detector lives at panel-level (owner of the enriched tree) for that
 * reason; the tree component only renders + listens to the store.
 *
 * Transition rules (previous snapshot → current snapshot):
 *   - path appears with change_status='added'          → write
 *   - path already tracked, additions/deletions change → edit
 *   - path disappears OR change_status='deleted'       → delete
 *
 * The hook is a no-op on the first run so the tree's initial load doesn't
 * fire a flood of false-positive flashes.
 */

import { useEffect, useRef } from "react";
import { recentActivityActions, type ActivityKind } from "../store/recentActivityStore";
import type { FileTreeNode } from "../types";

interface Snapshot {
  // Per-file signature that changes whenever any tracked field changes.
  // (additions, deletions, change_status, committed)
  byPath: Map<string, string>;
}

function buildLookup(nodes: FileTreeNode[]): Map<string, FileTreeNode> {
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

function buildSnapshot(lookup: Map<string, FileTreeNode>): Snapshot {
  const byPath = new Map<string, string>();
  for (const [path, node] of lookup) {
    byPath.set(
      path,
      `${node.additions ?? 0}:${node.deletions ?? 0}:${node.change_status ?? ""}:${
        node.committed === false ? "u" : node.committed === true ? "c" : ""
      }`
    );
  }
  return { byPath };
}

function classifyNew(node: FileTreeNode): ActivityKind {
  if (node.change_status === "deleted") return "delete";
  if (node.change_status === "added") return "write";
  return "edit";
}

export function useActivityDetector(workspaceId: string | null, nodes: FileTreeNode[]): void {
  const prevRef = useRef<Snapshot | null>(null);
  // Tracks the workspaceId the snapshot belongs to so a workspace switch
  // resets the detector cleanly instead of cross-comparing unrelated trees.
  const prevWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      prevRef.current = null;
      prevWorkspaceRef.current = null;
      return;
    }

    const fileLookup = buildLookup(nodes);
    const current = buildSnapshot(fileLookup);

    // First run for this workspace — seed and skip emission.
    if (prevRef.current === null || prevWorkspaceRef.current !== workspaceId) {
      prevRef.current = current;
      prevWorkspaceRef.current = workspaceId;
      return;
    }

    const prev = prevRef.current;

    for (const [path, node] of fileLookup) {
      const prevSig = prev.byPath.get(path);
      const nextSig = current.byPath.get(path);
      if (prevSig === nextSig) continue;

      if (prevSig === undefined) {
        // Path newly tracked — emit write (or delete if it showed up as deleted).
        recentActivityActions.record(workspaceId, {
          path,
          kind: classifyNew(node),
        });
      } else if (node.change_status === "deleted") {
        recentActivityActions.record(workspaceId, { path, kind: "delete" });
      } else {
        recentActivityActions.record(workspaceId, { path, kind: "edit" });
      }
    }

    // Paths that disappeared entirely — treat as delete.
    for (const path of prev.byPath.keys()) {
      if (!current.byPath.has(path)) {
        recentActivityActions.record(workspaceId, { path, kind: "delete" });
      }
    }

    prevRef.current = current;
    prevWorkspaceRef.current = workspaceId;
  }, [workspaceId, nodes]);
}
