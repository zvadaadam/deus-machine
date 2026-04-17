import type { RefEntry, SnapshotNode } from "../types.js";

/** Flat compact view — one interactive element per line. */
export function formatCompact(entries: RefEntry[]): string {
  return entries
    .map((e) => {
      const label = e.label ? ` "${truncate(e.label, 60)}"` : "";
      const value = e.value ? ` [${truncate(e.value, 40)}]` : "";
      const id = e.identifier ? ` #${e.identifier}` : "";
      const coords = `@(${Math.round(e.center.x)},${Math.round(e.center.y)})`;
      const disabled = e.enabled ? "" : " (disabled)";
      return `${e.ref} ${e.type}${label}${value}${id} ${coords}${disabled}`;
    })
    .join("\n");
}

/**
 * Indented tree view.
 *   @e1 Button "General" #BackButton @(38,84)
 *     Heading "About"
 *     Group
 *       · "Name, iPhone" #NAME_CELL_ID
 *       @e2 Button "iOS Version, 26.1" #SW_VERSION_SPECIFIER @(201,200)
 */
export function formatTree(nodes: SnapshotNode[]): string {
  const lines: string[] = [];
  for (const n of nodes) walk(n, 0, lines);
  return lines.join("\n");
}

function walk(node: SnapshotNode, depth: number, out: string[]): void {
  out.push(formatNode(node, depth));
  if (node.children) {
    for (const c of node.children) walk(c, depth + 1, out);
  }
}

function formatNode(node: SnapshotNode, depth: number): string {
  const pad = "  ".repeat(depth);
  const label = node.label ? ` "${truncate(node.label, 60)}"` : "";
  const value = node.value ? ` [${truncate(node.value, 40)}]` : "";
  const id = node.identifier ? ` #${node.identifier}` : "";

  if (node.interactive && node.ref) {
    const coords = `@(${Math.round(node.center.x)},${Math.round(node.center.y)})`;
    const disabled = node.enabled === false ? " (disabled)" : "";
    return `${pad}${node.ref} ${node.type}${label}${value}${id} ${coords}${disabled}`;
  }

  // Non-interactive context node — drop type for pure text, keep otherwise
  if (node.type === "StaticText" && label) {
    return `${pad}·${label}${value}${id}`;
  }
  return `${pad}${node.type}${label}${value}${id}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
