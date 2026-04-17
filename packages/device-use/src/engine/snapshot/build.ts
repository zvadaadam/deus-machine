import type { AccessibilityNode, RefEntry, Snapshot, SnapshotNode } from "../types.js";
import { RefMap } from "./refs.js";
import { isInteractive } from "./filter.js";

export interface BuildSnapshotOptions {
  /** When true, prune non-interactive leaves. Ancestors of interactive nodes are preserved. */
  interactiveOnly?: boolean;
  /** Existing ref counter to continue from (so refs don't collide across snapshots). */
  startCounter?: number;
  /**
   * Use an existing RefMap (so the caller can resolve refs later).
   * If provided, `startCounter` is ignored — the RefMap's own counter wins.
   * If omitted, a fresh RefMap is created internally.
   */
  refMap?: RefMap;
  /**
   * Include off-screen interactive nodes. Default `false` (visible-first):
   * refs are only assigned to nodes whose center is inside the screen bounds
   * inferred from the outermost Application root frame. Set `true` to get
   * every interactive node regardless of position (useful for --flat audits).
   */
  includeHidden?: boolean;
}

/**
 * Walk an AccessibilityNode tree and produce a Snapshot: a trimmed tree plus a
 * flat list of RefEntry values for every interactive node we found (DFS order).
 *
 * Interactive nodes are given a ref (`@eN`). Non-interactive nodes are kept
 * for context only when they carry information (label, identifier, value, or
 * descendants that do).
 */
export function buildSnapshot(
  roots: AccessibilityNode[],
  options: BuildSnapshotOptions = {}
): Snapshot {
  const refMap = options.refMap ?? new RefMap(options.startCounter ?? 0);
  const entries: RefEntry[] = [];

  // Infer screen bounds from the largest Application root frame. When
  // `includeHidden` is true, we skip this and accept all interactive nodes.
  const screen = options.includeHidden ? null : inferScreenBounds(roots);

  let total = 0;
  const tree: SnapshotNode[] = [];

  for (const node of roots) {
    const built = walk(node, refMap, entries, options, screen);
    total += built.total;
    if (built.node) tree.push(built.node);
  }

  return {
    tree,
    refs: entries,
    counts: { total, interactive: entries.length },
  };
}

interface ScreenBounds {
  width: number;
  height: number;
}

/** Largest Application-typed root frame — treated as the screen bounds. */
function inferScreenBounds(roots: AccessibilityNode[]): ScreenBounds | null {
  let bounds: ScreenBounds | null = null;
  for (const r of roots) {
    if (r.type === "Application" && r.frame.width > 0 && r.frame.height > 0) {
      if (!bounds || r.frame.width * r.frame.height > bounds.width * bounds.height) {
        bounds = { width: r.frame.width, height: r.frame.height };
      }
    }
  }
  return bounds;
}

function centerOnScreen(center: { x: number; y: number }, screen: ScreenBounds | null): boolean {
  if (!screen) return true;
  // Allow 1pt slop so elements flush against the bottom edge still count.
  return (
    center.x >= 0 && center.y >= 0 && center.x <= screen.width + 1 && center.y <= screen.height + 1
  );
}

interface WalkResult {
  node: SnapshotNode | null;
  total: number;
}

function walk(
  src: AccessibilityNode,
  refMap: RefMap,
  entries: RefEntry[],
  options: BuildSnapshotOptions,
  screen: ScreenBounds | null
): WalkResult {
  let total = 1;

  const kids: SnapshotNode[] = [];
  for (const child of src.children) {
    const built = walk(child, refMap, entries, options, screen);
    total += built.total;
    if (built.node) kids.push(built.node);
  }

  // Only on-screen enabled interactive nodes get a ref. Off-screen ones are
  // either dropped (interactiveOnly) or kept as non-interactive context
  // (default), so agents can still see they exist but can't tap them.
  const interactive = isInteractive(src) && src.enabled && centerOnScreen(src.center, screen);

  if (interactive) {
    const ref = refMap.nextRef();
    const entry: RefEntry = {
      ref,
      type: src.type,
      label: src.label,
      identifier: src.identifier,
      value: src.value,
      frame: src.frame,
      center: src.center,
      enabled: src.enabled,
      traits: src.traits,
    };
    refMap.set(entry);
    entries.push(entry);

    const node: SnapshotNode = {
      type: src.type,
      ref,
      label: src.label,
      identifier: src.identifier,
      value: src.value,
      frame: src.frame,
      center: src.center,
      enabled: src.enabled,
      interactive: true,
      traits: src.traits.length > 0 ? src.traits : undefined,
    };
    if (kids.length > 0) node.children = kids;
    return { node, total };
  }

  // Non-interactive — keep only if it carries signal
  const hasSignal = !!(src.label || src.identifier || src.value);
  const hasInteractiveDescendant = kids.length > 0;
  const keep = hasInteractiveDescendant || (!options.interactiveOnly && hasSignal);

  if (!keep) return { node: null, total };

  const node: SnapshotNode = {
    type: src.type,
    label: src.label,
    identifier: src.identifier,
    value: src.value,
    frame: src.frame,
    center: src.center,
  };
  if (kids.length > 0) node.children = kids;
  return { node, total };
}
