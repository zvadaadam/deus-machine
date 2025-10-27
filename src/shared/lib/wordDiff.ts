/**
 * Word-Level Diff Algorithm
 *
 * Computes character-by-character differences between two strings
 * and applies word-level highlighting to show exact changes.
 *
 * Used by DiffViewer to show saturated backgrounds on changed words,
 * GitHub-style visual emphasis on what actually changed.
 */

/**
 * Character range that should be highlighted
 */
export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Tokenize text into characters for granular diff
 * We'll work at character level for precision
 */
function tokenize(text: string): string[] {
  return text.split('');
}

/**
 * Compute Longest Common Subsequence (LCS) using dynamic programming
 * Returns indices of characters in common between old and new text
 */
function computeLCS(oldTokens: string[], newTokens: string[]): [number[], number[]] {
  const m = oldTokens.length;
  const n = newTokens.length;

  // DP table: lcs[i][j] = length of LCS of oldTokens[0...i-1] and newTokens[0...j-1]
  const lcs: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

  // Build LCS table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to find actual LCS
  const oldIndices: number[] = [];
  const newIndices: number[] = [];
  let i = m, j = n;

  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      oldIndices.unshift(i - 1);
      newIndices.unshift(j - 1);
      i--;
      j--;
    } else if (lcs[i - 1][j] > lcs[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return [oldIndices, newIndices];
}

/**
 * Find ranges of characters that differ between old and new text
 */
function findDiffRanges(tokens: string[], lcsIndices: number[]): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  let rangeStart = -1;

  for (let i = 0; i < tokens.length; i++) {
    const isInLCS = lcsIndices.includes(i);

    if (!isInLCS) {
      // Start or continue a diff range
      if (rangeStart === -1) {
        rangeStart = i;
      }
    } else {
      // End of diff range
      if (rangeStart !== -1) {
        ranges.push({ start: rangeStart, end: i });
        rangeStart = -1;
      }
    }
  }

  // Close any open range at end
  if (rangeStart !== -1) {
    ranges.push({ start: rangeStart, end: tokens.length });
  }

  // Merge adjacent ranges (within 1 char) for cleaner highlighting
  return mergeAdjacentRanges(ranges);
}

/**
 * Merge ranges that are very close together
 * This prevents highlighting individual characters with gaps
 */
function mergeAdjacentRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length === 0) return [];

  const merged: HighlightRange[] = [ranges[0]];

  for (let i = 1; i < ranges.length; i++) {
    const current = ranges[i];
    const last = merged[merged.length - 1];

    // Merge if gap is 1 char or less
    if (current.start - last.end <= 1) {
      last.end = current.end;
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Compute word-level diff between two text strings
 * Returns highlight ranges for both old and new text
 */
export function computeWordDiff(
  oldText: string,
  newText: string
): {
  oldRanges: HighlightRange[];
  newRanges: HighlightRange[];
} {
  // Tokenize into characters
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);

  // Find common characters (LCS)
  const [oldLCSIndices, newLCSIndices] = computeLCS(oldTokens, newTokens);

  // Find ranges that differ
  const oldRanges = findDiffRanges(oldTokens, oldLCSIndices);
  const newRanges = findDiffRanges(newTokens, newLCSIndices);

  return { oldRanges, newRanges };
}

/**
 * Apply word-level highlights to syntax-highlighted HTML
 *
 * Takes Shiki's HTML output and wraps changed portions in <mark> tags
 * Preserves Shiki's <span> structure while adding our highlights
 *
 * @param htmlContent - Shiki's syntax-highlighted HTML
 * @param plainText - Original plain text (for position tracking)
 * @param ranges - Character ranges to highlight
 * @param type - 'addition' or 'deletion' (determines CSS class)
 */
export function applyWordHighlights(
  htmlContent: string,
  plainText: string,
  ranges: HighlightRange[],
  type: 'addition' | 'deletion'
): string {
  if (ranges.length === 0) {
    return htmlContent;
  }

  // CSS class for word-level highlights
  const markClass = type === 'addition' ? 'diff-word-addition' : 'diff-word-deletion';

  // Parse HTML to track positions
  // Strategy: Walk through HTML and plain text simultaneously
  // When we hit a range, insert <mark> tags

  let result = '';
  let plainTextPos = 0;
  let htmlPos = 0;
  let currentRangeIndex = 0;
  let inTag = false;
  let markOpen = false;

  while (htmlPos < htmlContent.length) {
    const char = htmlContent[htmlPos];

    // Track when we're inside an HTML tag
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
      result += char;
      htmlPos++;
      continue;
    }

    // If inside tag, just copy
    if (inTag) {
      result += char;
      htmlPos++;
      continue;
    }

    // If it's an HTML entity, handle specially
    if (char === '&') {
      const entityMatch = htmlContent.slice(htmlPos).match(/^&[a-z]+;/i);
      if (entityMatch) {
        // Copy entity and advance plain text by 1
        result += entityMatch[0];
        htmlPos += entityMatch[0].length;
        plainTextPos++;
        continue;
      }
    }

    // Check if we should start a highlight
    if (
      currentRangeIndex < ranges.length &&
      plainTextPos === ranges[currentRangeIndex].start &&
      !markOpen
    ) {
      result += `<mark class="${markClass}">`;
      markOpen = true;
    }

    // Copy the character
    result += char;
    plainTextPos++;
    htmlPos++;

    // Check if we should end a highlight
    if (
      markOpen &&
      currentRangeIndex < ranges.length &&
      plainTextPos >= ranges[currentRangeIndex].end
    ) {
      result += '</mark>';
      markOpen = false;
      currentRangeIndex++;
    }
  }

  // Close any open mark tag
  if (markOpen) {
    result += '</mark>';
  }

  return result;
}
