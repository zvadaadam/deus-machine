/**
 * Compute actual added/removed line counts between two strings.
 *
 * Uses bag-of-lines matching (not order-preserving) which gives
 * correct results for typical code edits: insertions, deletions,
 * and replacements. Handles duplicate lines via occurrence counting.
 */
export function computeDiffStats(
  oldStr: string,
  newStr: string
): { added: number; removed: number } {
  if (oldStr === newStr) return { added: 0, removed: 0 };

  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // Count occurrences of each line in old
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) {
    oldCounts.set(line, (oldCounts.get(line) || 0) + 1);
  }

  // Match new lines against old, consuming occurrences
  let matched = 0;
  for (const line of newLines) {
    const count = oldCounts.get(line);
    if (count !== undefined && count > 0) {
      oldCounts.set(line, count - 1);
      matched++;
    }
  }

  return {
    added: newLines.length - matched,
    removed: oldLines.length - matched,
  };
}
