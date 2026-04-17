import type { RefEntry } from "../types.js";

export interface SnapshotDiffEntry {
  kind: "added" | "removed" | "changed";
  type: string;
  label?: string;
  identifier?: string;
  changes?: string[];
}

export interface SnapshotDiff {
  added: SnapshotDiffEntry[];
  removed: SnapshotDiffEntry[];
  changed: SnapshotDiffEntry[];
  unchanged: number;
}

type RefEntryLike = Omit<RefEntry, "ref">;

function identityKey(e: RefEntryLike): string {
  if (e.identifier) return `${e.type}::id::${e.identifier}`;
  return `${e.type}::label::${e.label ?? ""}`;
}

function toEntry(
  kind: SnapshotDiffEntry["kind"],
  e: RefEntryLike,
  changes?: string[]
): SnapshotDiffEntry {
  return {
    kind,
    type: e.type,
    label: e.label,
    identifier: e.identifier,
    ...(changes && { changes }),
  };
}

export function diffSnapshots(previous: RefEntryLike[], current: RefEntryLike[]): SnapshotDiff {
  const prevGroups = groupByKey(previous);
  const currGroups = groupByKey(current);

  const allKeys = new Set([...prevGroups.keys(), ...currGroups.keys()]);
  const added: SnapshotDiffEntry[] = [];
  const removed: SnapshotDiffEntry[] = [];
  const changed: SnapshotDiffEntry[] = [];
  let unchanged = 0;

  for (const key of allKeys) {
    const prevList = prevGroups.get(key) ?? [];
    const currList = currGroups.get(key) ?? [];
    const matched = Math.min(prevList.length, currList.length);

    for (let i = 0; i < matched; i++) {
      const changes = fieldChanges(prevList[i]!, currList[i]!);
      if (changes.length > 0) {
        changed.push(toEntry("changed", currList[i]!, changes));
      } else {
        unchanged++;
      }
    }

    for (let i = matched; i < currList.length; i++) {
      added.push(toEntry("added", currList[i]!));
    }

    for (let i = matched; i < prevList.length; i++) {
      removed.push(toEntry("removed", prevList[i]!));
    }
  }

  return { added, removed, changed, unchanged };
}

function groupByKey(entries: RefEntryLike[]): Map<string, RefEntryLike[]> {
  const groups = new Map<string, RefEntryLike[]>();
  for (const e of entries) {
    const key = identityKey(e);
    const list = groups.get(key);
    if (list) {
      list.push(e);
    } else {
      groups.set(key, [e]);
    }
  }
  return groups;
}

function fieldChanges(a: RefEntryLike, b: RefEntryLike): string[] {
  const out: string[] = [];
  if (a.value !== b.value) out.push(`value: '${a.value ?? ""}' → '${b.value ?? ""}'`);
  if (a.enabled !== b.enabled) out.push(`enabled: ${a.enabled} → ${b.enabled}`);
  if (a.label !== b.label) out.push(`label: '${a.label ?? ""}' → '${b.label ?? ""}'`);
  if (Math.abs(a.center.x - b.center.x) > 2 || Math.abs(a.center.y - b.center.y) > 2) {
    out.push(
      `position: (${Math.round(a.center.x)},${Math.round(a.center.y)}) → (${Math.round(b.center.x)},${Math.round(b.center.y)})`
    );
  }
  return out;
}

function entryName(e: SnapshotDiffEntry): string {
  return e.identifier ?? e.label ?? e.type;
}

export function formatDiff(diff: SnapshotDiff): string {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return "No changes from previous snapshot";
  }

  const lines: string[] = [];

  for (const e of diff.added) lines.push(`+ ${e.type} "${entryName(e)}"`);
  for (const e of diff.removed) lines.push(`- ${e.type} "${entryName(e)}"`);
  for (const e of diff.changed) {
    lines.push(`~ ${e.type} "${entryName(e)}": ${e.changes?.join(", ") ?? ""}`);
  }

  const summary = [
    diff.added.length > 0 ? `+${diff.added.length} added` : null,
    diff.removed.length > 0 ? `-${diff.removed.length} removed` : null,
    diff.changed.length > 0 ? `~${diff.changed.length} changed` : null,
    diff.unchanged > 0 ? `${diff.unchanged} unchanged` : null,
  ]
    .filter(Boolean)
    .join(", ");

  lines.push(`\n(${summary})`);
  return lines.join("\n");
}
